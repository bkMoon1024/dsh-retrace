/**
 * dsh-retrace — Rollback executor (PLAN.md §4.5).
 *
 * Rolls a session (and optionally its artifacts) back to a recorded version:
 *
 *   scope 'context'   — append an invisible replacement marker shadowing every
 *                       surface node added AFTER the version boundary, so the
 *                       model-visible history rewinds to that point (git-checkout
 *                       semantics: the rewound content stays in the durable log
 *                       as a later version — non-destructive, auditable).
 *   scope 'artifacts' — restore the files the version's window touched to their
 *                       content at that version: git checkout when the workspace
 *                       is a repository and the version recorded a HEAD, else
 *                       content-addressed snapshot read-back through `ctx.fs`
 *                       (CAS-guarded), with subprocess `rm` for files that were
 *                       deleted in the version's window (realpath-in-workspace +
 *                       in-manifest guards only).
 *   scope 'both'      — context first, then artifacts.
 *
 * Every execution is dry-run-previewable first and records the restore as a new
 * version (kind='restore') in the projection feed, so a rollback is itself a
 * version and can be rolled back again (idempotent per-session lock included).
 */
import { isAbsolute, relative, resolve } from 'node:path'
import { foldSurface } from '@deepseek-ai/dsh-session'
import { editorError, serializeSession, serializeWorkspace, sessionEvents } from './host-core.js'
import { capabilityMessage, capabilitiesForScope, resolveCapabilities } from './capabilities.js'

const VALID_SCOPES = ['context', 'artifacts', 'both']

/**
 * Create the rollback executor.
 * @param {object} deps
 * @param {object} deps.ctx            — host context (ctx.fs / ctx.subprocess / ctx.sandboxPolicy).
 * @param {object} deps.sessions       — session registry (sessions.get / sessions.flush).
 * @param {object} deps.seam           — versioning seam (snapshot / resolveSnapshot /
 *                                       readSnapshot / gitStatus / gitHeadFor).
 * @param {object} [deps.agents]       — agent registry (agents.get) 用于轮次间 marker 的
 *                                       turn 信封推进 agent-loop 计数器（writeMarker 情形③）。
 * @param {Function} [deps.writeMarker] — 遮蔽写入器（adapter 注入；业务层只表达遮蔽意图）。
 * @param {(line: string) => void} [deps.log]
 */
export function createRollbackExecutor({ ctx, sessions, agents, seam, validateMarker, writeMarker, log = () => {}, capabilities = resolveCapabilities(), options = {} }) {
  /**
   * Preview tickets: a plan is executable only after a preview produced it, and
   * only once. The client's span/scope/version are never authoritative — the
   * ticket carries what the server actually planned.
   */
  const PLANS = new Map()
  const PLAN_TTL_MS = options.planTtlMs ?? 5 * 60_000
  let planCounter = 0

  /** Refuse a scope whose restore path is gated off in this build. */
  function requireCapabilities(scope) {
    for (const capability of capabilitiesForScope(scope)) {
      if (capabilities?.[capability] !== true) {
        throw editorError('capability-disabled', capabilityMessage(capability))
      }
    }
  }

  /** One in-flight operation per session, shared with the editor entry points. */
  function locked(sessionId, fn) {
    return serializeSession(ctx, sessionId, fn)
  }

  /** Latest boundary the session has reached (plan staleness check). */
  function revisionOf(sessionId) {
    const versions = seam.snapshot(sessionId).versions ?? []
    return versions.at(-1)?.boundarySeq ?? 0
  }

  /** Drop expired tickets; called before every ticket lookup. */
  function prunePlans(now) {
    for (const [id, plan] of PLANS) {
      if (now - plan.createdAt > PLAN_TTL_MS) PLANS.delete(id)
    }
  }

  function requireSession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw editorError('bad-request', 'sessionId must be a non-empty string')
    }
    const session = sessions.get(sessionId)
    if (!session) throw editorError('session-not-found', `session "${sessionId}" not found`)
    return session
  }

  function requireIdle(sessionId) {
    const agent = seam.agentOf?.(sessionId)
    if (agent && typeof agent.status === 'string' && agent.status === 'running') {
      throw editorError('agent-busy', 'The agent is still responding; stop the current reply before rolling back.')
    }
  }

  function versionOf(sessionId, versionId) {
    const snap = seam.snapshot(sessionId)
    const record = (snap.versions ?? []).find((v) => v.versionId === versionId)
    if (!record) throw editorError('version-not-found', `version "${versionId}" not found in session "${sessionId}"`)
    return record
  }

  function cwdOf(session) {
    return typeof session.header?.cwd === 'string' ? session.header.cwd : null
  }

  /**
   * Git facts for a rollback: the HEAD recorded at the version boundary (the
   * content we must restore) plus the live status (cwd / dirty detection).
   * A version without recorded facts falls back to content snapshots.
   */
  async function gitFactsFor(sessionId, record) {
    if (!seam.configFor(sessionId).git) return null
    const status = await seam.gitStatus(sessionId)
    if (!status) return null
    const facts = await seam.gitHeadFor(sessionId, record.versionId)
    return { headHash: facts?.headHash ?? null, dirty: status.dirty === true }
  }

  /**
   * The surface diff of "now" vs the version boundary: every current surface
   * node absent from the version's folded surface. An empty diff means the
   * session is already at (or before) that version.
   *
   * Reads through `sessionEvents()` (snapshotEvents on the current host) — the
   * previous `session.events.slice(...)` threw a TypeError on hosts without the
   * legacy `events` array, and a failed read must never look like "nothing to
   * restore".
   */
  function contextDiff(session, record) {
    const events = sessionEvents(session)
    if (!Array.isArray(events) || events.length === 0) {
      throw editorError('log-unavailable', 'The session log is not readable from this host; cannot compute what to restore.')
    }
    const boundary = Math.min(record.boundarySeq, events.length - 1)
    const target = foldSurface(events.slice(0, boundary + 1))
    const targetNodes = new Set(target.nodes)
    const current = Array.isArray(session.surface?.nodes) ? session.surface.nodes : []
    if (current.length === 0) {
      throw editorError('log-unavailable', 'This host exposes no surface for the session; cannot compute what to restore.')
    }
    const diff = current.filter((seq) => !targetNodes.has(seq))
    // A replacement marker can only hide current nodes; it can never bring back
    // a node the surface no longer shows. When the target had nodes the current
    // surface lacks, the only honest answer is to refuse: appending a marker
    // here would report "restored" while the target surface is not reproduced.
    const currentSet = new Set(current)
    const missing = [...targetNodes].filter((seq) => !currentSet.has(seq))
    return {
      messages: diff.length,
      diff,
      firstSeq: diff.length > 0 ? diff[0] : null,
      lastSeq: diff.length > 0 ? diff[diff.length - 1] : null,
      resurrect: missing.length,
      restorable: missing.length === 0,
      missing,
    }
  }

  /** Realpath must stay inside the workspace and match a manifest path. */
  async function workspaceRealpath(session, relPath) {
    const cwd = cwdOf(session)
    if (!cwd) return null
    const target = await ctx.fs.resolve(relPath, { cwd })
    const root = await ctx.fs.resolve('.', { cwd })
    if (!ctx.fs.contains(root, target)) return null
    return target
  }

  /**
   * Reference lookup that also reports whether the capture is provable. Seams
   * without `snapshotState` (older builds) degrade to the bare address.
   */
  async function snapshotRef(seam, session, record, path) {
    if (typeof seam.snapshotState === 'function') {
      return seam.snapshotState(session.id, record.versionId, path)
    }
    const sha = await seam.resolveSnapshot(session.id, record.versionId, path)
    return sha ? { sha256: sha, racy: false } : null
  }

  /** Artifact plan for one version: per file the action and the method. */
  async function artifactPlan(session, record, gitFacts) {
    const rows = []
    const cwd = cwdOf(session)
    const headHash = gitFacts?.headHash
    for (const file of record.touchedFiles) {
      if (file.mode === 'deleted') {
        const target = cwd ? await workspaceRealpath(session, file.path) : null
        rows.push({
          path: file.path,
          action: 'delete',
          method: 'subprocess',
          safe: target !== null,
        })
        continue
      }
      if (gitFacts && headHash) {
        rows.push({ path: file.path, action: 'restore', method: 'git', safe: true })
        continue
      }
      const state = await snapshotRef(seam, session, record, file.path)
      if (!state?.sha256) rows.push({ path: file.path, action: 'skip', reason: 'no-snapshot' })
      else if (state.racy) rows.push({ path: file.path, action: 'skip', reason: 'snapshot-racy' })
      else rows.push({ path: file.path, action: 'restore', method: 'snapshot', safe: true })
    }
    // `enabled` only when the boundary recorded a HEAD we can actually check
    // out; `dirty` lets the client warn before overwriting uncommitted work.
    const git = gitFacts
      ? { enabled: headHash !== null, headHash: headHash ?? null, dirty: gitFacts.dirty === true }
      : { enabled: false }
    return { rows, git }
  }

  /** Dry-run preview: what a rollback would remove / touch (no side effects). */
  async function preview(args) {
    const sessionId = String(args?.sessionId ?? '')
    const versionId = String(args?.versionId ?? '')
    const scope = String(args?.scope ?? 'both')
    if (!VALID_SCOPES.includes(scope)) throw editorError('bad-scope', `scope must be one of ${VALID_SCOPES.join(', ')}`)
    requireCapabilities(scope)
    const session = requireSession(sessionId)
    const record = versionOf(sessionId, versionId)
    const context = contextDiff(session, record)
    const gitFacts = await gitFactsFor(sessionId, record)
    const artifacts = await artifactPlan(session, record, gitFacts)
    const applicable = scope === 'context'
      ? context.messages > 0
      : scope === 'artifacts'
        ? artifacts.rows.length > 0
        : context.messages > 0 || artifacts.rows.length > 0
    const now = Date.now()
    prunePlans(now)
    const planId = `plan-${now.toString(36)}-${(++planCounter).toString(36)}`
    PLANS.set(planId, {
      planId,
      sessionId,
      versionId,
      scope,
      revision: revisionOf(sessionId),
      createdAt: now,
      used: false,
      restorable: context.restorable,
    })
    return {
      planId,
      versionId,
      kind: record.kind,
      boundarySeq: record.boundarySeq,
      scope,
      context,
      artifacts,
      applicable,
      expiresInMs: PLAN_TTL_MS,
    }
  }

  /** Delete one manifest file, after realpath-in-workspace verification. */
  async function removeOne(session, file) {
    const target = await workspaceRealpath(session, file.path)
    if (!target) return { path: file.path, status: 'skipped', reason: 'outside-workspace' }
    const cwd = cwdOf(session)
    if (!cwd) return { path: file.path, status: 'skipped', reason: 'no-cwd' }
    try {
      await ctx.fs.stat(target)
    } catch {
      return { path: file.path, status: 'deleted' } // already gone
    }
    // Prefer the sandboxed fs service; `rm` is not present on every platform.
    if (typeof ctx.fs.remove === 'function') {
      try {
        await ctx.fs.remove(target)
        return { path: file.path, status: 'deleted' }
      } catch (error) {
        log(`retrace: fs.remove failed for ${file.path}, falling back to rm: ${String(error)}`)
      }
    }
    const handle = ctx.subprocess.spawn({
      argv: ['rm', '--', relative(resolve(cwd), resolve(target))],
      cwd,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 64 * 1024 }, stderr: { maxBytes: 64 * 1024 } },
      graceMs: 15_000,
      signal: undefined,
      env: {},
    })
    const outcome = await handle.done
    return { path: file.path, status: outcome.exitCode === 0 ? 'deleted' : 'failed' }
  }

  /** Restore one snapshot file through the sandboxed fs (CAS-guarded write). */
  async function restoreSnapshot(session, file, sha) {
    const cwd = cwdOf(session)
    if (!cwd) return { path: file.path, status: 'skipped', reason: 'no-cwd' }
    const bytes = await seam.readSnapshot(sha)
    const text = new TextDecoder().decode(bytes)
    const target = await ctx.fs.resolve(file.path, { cwd })
    let expected
    try {
      const stat = await ctx.fs.stat(target)
      if (stat && typeof stat.version === 'number') expected = { kind: 'replaceIfVersion', version: stat.version }
    } catch { /* missing file: plain create */ }
    const policy = ctx.sandboxPolicy?.resolve?.({ session, mode: 'workspace-write' })
    await ctx.fs.writeText(target, text, expected, undefined, policy)
    return { path: file.path, status: 'restored' }
  }

  /** Execute artifact rollback for one version (git first, snapshot fallback). */
  async function rollbackArtifacts(session, record, gitFacts) {
    const results = []
    const cwd = cwdOf(session)
    const gitPaths = []
    const snapshotJobs = []
    const deletes = []
    const headHash = gitFacts?.headHash
    for (const file of record.touchedFiles) {
      if (file.mode === 'deleted') {
        deletes.push(file)
        continue
      }
      if (gitFacts && headHash) {
        gitPaths.push(file.path)
        continue
      }
      const state = await snapshotRef(seam, session, record, file.path)
      if (!state?.sha256) results.push({ path: file.path, status: 'skipped', reason: 'no-snapshot' })
      else if (state.racy) results.push({ path: file.path, status: 'skipped', reason: 'snapshot-racy' })
      else snapshotJobs.push({ file, sha: state.sha256 })
    }
    if (gitPaths.length > 0 && cwd && headHash) {
      const outcome = await seam.gitCheckout(cwd, headHash, gitPaths)
      for (const path of gitPaths) {
        results.push({
          path,
          status: outcome.ok && outcome.checked.includes(path) ? 'restored' : outcome.ok ? 'unchanged' : 'failed',
        })
      }
    }
    for (const { file, sha } of snapshotJobs) {
      try {
        results.push(await restoreSnapshot(session, file, sha))
      } catch (error) {
        results.push({ path: file.path, status: 'failed', reason: String(error) })
      }
    }
    for (const file of deletes) {
      try {
        results.push(await removeOne(session, file))
      } catch (error) {
        results.push({ path: file.path, status: 'failed', reason: String(error) })
      }
    }
    return results
  }

  /**
   * Execute a rollback. The ticket from `preview` is required: it is the only
   * proof that the user saw this exact plan (session, version, scope, revision),
   * it is single-use, and it expires.
   */
  async function execute(args) {
    const sessionId = String(args?.sessionId ?? '')
    const versionId = String(args?.versionId ?? '')
    const scope = String(args?.scope ?? 'both')
    const planId = String(args?.planId ?? '')
    if (!VALID_SCOPES.includes(scope)) throw editorError('bad-scope', `scope must be one of ${VALID_SCOPES.join(', ')}`)
    requireCapabilities(scope)
    return locked(sessionId, async () => {
      const session = requireSession(sessionId)
      requireIdle(sessionId)
      const plan = consumePlan(planId, { sessionId, versionId, scope })
      const record = versionOf(sessionId, versionId)
      const gitFacts = await gitFactsFor(sessionId, record)
      if (scope !== 'context' && gitFacts?.dirty) {
        throw editorError(
          'working-tree-dirty',
          'The workspace has uncommitted changes; commit or discard them before rolling back artifacts.',
        )
      }
      const outcome = { op: 'restore', versionId, scope, markerSeq: null, artifacts: [], context: { messages: 0 } }

      if (scope === 'context' || scope === 'both') {
        const { diff, restorable, resurrect } = contextDiff(session, record)
        if (!restorable) {
          throw editorError(
            'restore-unsupported',
            `This version had ${resurrect} message(s) the session no longer shows; a replacement marker cannot bring them back. Use a checkpoint branch instead of rolling the context back.`,
          )
        }
        if (diff.length > 0) {
          const span = { start: diff[0], end: diff[diff.length - 1], shadowedSeqs: diff.slice() }
          if (typeof writeMarker !== 'function') {
            throw editorError('writer-unavailable', 'No marker writer (adapter) is wired; cannot restore context.')
          }
          const markerEvent = await writeMarker(session, span, { op: 'restore', targetSeq: record.boundarySeq, originalText: '' })
          const flushWarning = await flushSafely(session)
          outcome.markerSeq = markerEvent.seq
          outcome.context = { messages: diff.length }
          if (flushWarning) outcome.flushWarning = flushWarning
        }
      }

      if (scope === 'artifacts' || scope === 'both') {
        // Artifact writes are workspace-scoped: two sessions in one workspace
        // must not restore files at the same time.
        const cwd = cwdOf(session)
        outcome.artifacts = cwd
          ? await serializeWorkspace(ctx, cwd, () => rollbackArtifacts(session, record, gitFacts))
          : await rollbackArtifacts(session, record, gitFacts)
      }
      await recordOperation({ op: 'restore', sessionId, versionId, scope, planId, outcome })
      return outcome
    })
  }

  /** Validate and consume one preview ticket. */
  function consumePlan(planId, expected) {
    if (typeof planId !== 'string' || planId.length === 0) {
      throw editorError('plan-required', 'Preview this rollback first; execute needs the plan id it returned.')
    }
    const now = Date.now()
    prunePlans(now)
    const plan = PLANS.get(planId)
    if (!plan) throw editorError('plan-expired', 'This preview expired or was already used; preview again.')
    if (plan.used) throw editorError('plan-used', 'This preview was already executed; preview again.')
    if (plan.sessionId !== expected.sessionId || plan.versionId !== expected.versionId || plan.scope !== expected.scope) {
      throw editorError('plan-mismatch', 'The request does not match the preview it references; preview again.')
    }
    const revision = revisionOf(expected.sessionId)
    if (revision !== plan.revision) {
      throw editorError('plan-stale', 'The session changed since this preview; preview again.')
    }
    plan.used = true
    return plan
  }

  /**
   * One audit line per executed rollback. Never stores message text or file
   * contents — only ids, scope and per-file status.
   */
  async function recordOperation(entry) {
    try {
      const record = seam.recordOperation
      if (typeof record !== 'function') return
      await record({
        at: Date.now(),
        op: entry.op,
        sessionId: entry.sessionId,
        versionId: entry.versionId,
        scope: entry.scope,
        planId: entry.planId,
        markerSeq: entry.outcome?.markerSeq ?? null,
        contextMessages: entry.outcome?.context?.messages ?? 0,
        flushWarning: entry.outcome?.flushWarning ?? null,
        artifacts: (entry.outcome?.artifacts ?? []).map((row) => ({ path: row.path, status: row.status, reason: row.reason ?? null })),
      })
    } catch (error) {
      log(`retrace: operation record failed: ${String(error)}`)
    }
  }

  async function flushSafely(session) {
    try {
      if (typeof sessions.flush === 'function') await sessions.flush(session)
      return null
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log(`retrace: flush failed: ${message}`)
      return message
    }
  }

  return { preview, execute }
}
