/**
 * dsh-retrace — the versioning seam: projection unit registration, artifact
 * snapshot side effects, the `retrace` storageDomain, and the per-session
 * config view.
 *
 * PLAN.md §4.1/§4.3/§4.6. Everything here lives behind `ctx.inject(...)` so
 * headless compositions without `sessionProjections`/`sessionQuery`/
 * `storageDomain` simply never activate it — the plugin degrades to plain L1
 * (recall / edit / regenerate) with no versioning surface, exactly like
 * 0.2.x.
 *
 * The projection unit is registered unconditionally once the seam is
 * available (pure fold, framework-owned cache, negligible cost). The
 * "versioning off" switch is honored at the side-effect and HTTP surface:
 * no snapshots are written and `/versions` reports `enabled: false` — the
 * user-visible behavior is identical to 0.2.x either way.
 */
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import {
  createArtifactStore,
  gcArtifacts,
  refFor,
  retraceDomainSpec,
} from './artifact-store.js'
import { versionsProjectionDefinition } from './projection/versions.js'
import { forkmapProjectionDefinition } from './projection/forkmap.js'
import { createGitAdapter, createSubprocessRunner } from './git-adapter.js'
import { resolveCapabilities } from './capabilities.js'
import { sessionEvents } from './host-core.js'
import { editorOf, eventAt, messageIdOf } from './adapter/normalize.js'

/** Whether an event is one of our own markers (either marker generation). */
function isMarkerEvent(event) {
  if (!event || !editorOf(event)) return false
  const id = messageIdOf(event)
  return typeof id === 'string' && (id.startsWith('retrace-') || id.startsWith('message-editor-'))
}

/** Max bytes snapshotted per touched file (over → file skipped, version kept). */
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024
/** NUL-byte probe window for binary detection. */
const BINARY_PROBE_BYTES = 1024

/** Default per-session config (client may override per request). */
export const DEFAULT_RETRACE_CONFIG = { versioning: true, git: true, retentionLimit: 50, prewrite: true }

function localTokenMeterViolations(events) {
  const violations = []
  let open = null
  for (const row of events) {
    const event = row?.event ?? row
    if (event?.type === 'step/start') {
      if (open) violations.push({ id: 'T1', eventType: 'step/start', seq: event.seq, message: 'step/start overlaps an open step' })
      open = { turn: event.data?.turn, step: event.data?.step }
    } else if (event?.type === 'step/end') {
      if (!open || open.turn !== event.data?.turn || open.step !== event.data?.step) {
        violations.push({ id: 'T1', eventType: event.type, seq: event.seq, message: 'step/end does not close the open step' })
      }
      open = null
    } else if (event?.type === 'assistant/message' && event.data?.turn != null) {
      if (!open || open.turn !== event.data?.turn || open.step !== event.data?.step) {
        violations.push({ id: 'T1', eventType: event.type, seq: event.seq, message: 'assistant/message is outside an open step' })
      }
    }
  }
  return violations
}

function isBinary(bytes) {
  const probe = bytes.subarray(0, BINARY_PROBE_BYTES)
  for (const byte of probe) if (byte === 0) return true
  return false
}

/**
 * Create the versioning seam for one plugin context.
 * `register()` must run synchronously inside `apply` so the `ctx.inject`
 * effects attach to the plugin fiber.
 * @param {object} options - `storeRoot` overrides the artifact root
 *   (defaults to `$DSH_HOME/dsh-retrace`); tests use a temp directory.
 */
export function createVersioningSeam(ctx, log = () => {}, options = {}) {
  let registered = false
  let seamCtx = null
  let domain = null
  let store = null
  let git = null
  const disposers = []
  /** Per-session request-carried config; merged over the durable global defaults. */
  const configs = new Map()
  /** Durable domain-global defaults (null until the domain opens). */
  let durableGlobal = null
  /** Capability gates for this seam instance (see lib/capabilities.js). */
  const capabilities = resolveCapabilities(options.capabilities)

  /** The resolved gates, read-only view (HTTP /capabilities). */
  function capabilitiesView() {
    return { ...capabilities }
  }

  function configFor(sessionId) {
    return { ...DEFAULT_RETRACE_CONFIG, ...(durableGlobal ?? {}), ...(configs.get(sessionId) ?? {}) }
  }

  function setConfig(sessionId, config) {
    configs.set(sessionId, { ...DEFAULT_RETRACE_CONFIG, ...config })
  }

  /** Versioning surface availability (false in headless/minimal compositions). */
  function available() {
    return seamCtx !== null
  }

  /** Read one touched file through the sandboxed fs and snapshot it. */
  async function snapshotOne(session, record, file) {
    const cwd = session.header?.cwd
    if (typeof cwd !== 'string' || cwd.length === 0) return
    try {
      const target = await ctx.fs.resolve(file.path, { cwd })
      const workspaceTarget = await ctx.fs.resolve('.', { cwd })
      if (!ctx.fs.contains(workspaceTarget, target)) return // outside the workspace
      const bytes = await ctx.fs.readBytes(target, undefined, MAX_SNAPSHOT_BYTES)
      if (isBinary(bytes)) return
      const { sha256, sizeBytes } = await store.save(bytes)
      const refsTable = domain.table('refcounts')
      const ref = refFor(record.versionId, file.path)
      const prev = refsTable.get(sha256)
      if (prev && !prev.refs.includes(ref)) {
        await refsTable.put(sha256, { ...prev, refs: [...prev.refs, ref] })
      } else if (!prev) {
        await refsTable.put(sha256, {
          refs: [ref],
          sizeBytes,
          createdAt: typeof record.createdAt === 'number' ? record.createdAt : Date.now(),
        })
      }
    } catch (error) {
      log(`retrace: snapshot skipped for ${file.path}: ${String(error)}`)
    }
  }

  /** Side effect: snapshot every non-deleted touched file of a new version. */
  async function snapshotVersionFiles(session, record) {
    if (!domain || !store || !configFor(session.id).versioning) return
    // Boundary-time capture reads the workspace after the fact; it stays off
    // until the capture work package can prove the bytes belong to the boundary.
    if (!capabilities.artifactCapture) return
    await Promise.allSettled(
      record.touchedFiles
        .filter((file) => file.mode !== 'deleted')
        .map((file) => snapshotOne(session, record, file)),
    )
  }

  /**
   * Side effect: record the git facts (HEAD + dirty) of a new version boundary
   * (PLAN §4.4 commit-free). Read-only commands only; best-effort — a failure
   * just leaves the version without git facts (snapshot rollback still works).
   */
  async function recordVersionGit(session, record) {
    if (!domain || !git || !configFor(session.id).git) return
    if (!capabilities.artifactCapture) return
    const cwd = session.header?.cwd
    if (typeof cwd !== 'string' || cwd.length === 0) return
    try {
      const status = await git.status(cwd)
      await domain.table('versiongit').put(record.versionId, {
        headHash: status?.headHash ?? null,
        dirty: status?.dirty ?? false,
      })
    } catch (error) {
      log(`retrace: git facts skipped for ${record.versionId}: ${String(error)}`)
    }
  }

  /** The git adapter, created lazily once the seam context is available. */
  function ensureGit() {
    if (git === null && seamCtx !== null) {
      // `ctx.subprocess` is a cordis getter that throws when the service is not
      // injected; headless/minimal compositions degrade to snapshot-only
      // rollback instead of crashing the plugin.
      let subprocess
      try {
        subprocess = ctx.subprocess
      } catch {
        subprocess = undefined
      }
      if (subprocess) git = createGitAdapter(createSubprocessRunner(ctx, log))
    }
    return git
  }

  // -------------------------------------------------------------------------
  // P1.5 — bounded retention: background GC over the artifact store.
  // -------------------------------------------------------------------------
  /** sessionId → retained versionIds (updated at every boundary we observe). */
  const retainedVersions = new Map()
  /** sessionId → every versionId this process has observed (truncation memory). */
  const knownVersions = new Map()
  /** Throttle: one sweep per session at most every GC_INTERVAL_MS. */
  const lastGc = new Map()
  const GC_INTERVAL_MS = options.gcIntervalMs ?? 60_000
  /** Objects younger than this are never swept (in-flight snapshot guard). */
  const GC_GRACE_MS = options.gcGraceMs ?? 10 * 60_000
  /** Serialized sweep chain: two sessions can never GC concurrently. */
  let gcChain = Promise.resolve()

  function noteRetained(sessionId, versions) {
    const config = configFor(sessionId)
    const ids = versions.map((v) => v.versionId)
    const known = knownVersions.get(sessionId) ?? new Set()
    for (const id of ids) known.add(id)
    knownVersions.set(sessionId, known)
    // The retentionLimit setting bounds how many recent versions keep their
    // artifact snapshots; older refs are released by the next sweep. Turning
    // versioning off must not delete history that was recorded while it was on.
    const limit = config.versioning
      ? Math.max(1, Math.min(1000, Math.floor(config.retentionLimit ?? 50)))
      : ids.length
    retainedVersions.set(sessionId, new Set(ids.slice(-limit)))
  }

  /** Union of retained version ids across sessions. */
  function retainedUnion() {
    const retained = new Set()
    for (const ids of retainedVersions.values()) for (const id of ids) retained.add(id)
    return retained
  }

  /** Union of version ids this process has observed (retained or truncated). */
  function knownUnion() {
    const known = new Set()
    for (const ids of knownVersions.values()) for (const id of ids) known.add(id)
    return known
  }

  /**
   * Filter a refcounts record to the references still retained by any known
   * session. Versions this process has never observed are kept (conservative —
   * a cold session we have not seen yet may still reference them); only
   * versions we know were truncated by the bounded projection are released.
   */
  function retainedRefs(refs) {
    const retained = retainedUnion()
    const known = knownUnion()
    return refs.filter((ref) => {
      const colon = ref.indexOf(':')
      const versionId = colon === -1 ? ref : ref.slice(0, colon)
      return retained.has(versionId) || !known.has(versionId)
    })
  }

  /**
   * Throttled, serialized sweep: release refs of truncated versions, delete
   * zero-ref rows, drop unreferenced objects (fresh objects are spared by the
   * store's grace window so an in-flight snapshot can never lose its blob),
   * and prune versiongit rows only for versions we know were truncated.
   */
  function sweepGc(sessionId) {
    gcChain = gcChain
      .then(() => sweepGcNow(sessionId))
      .catch((error) => log(`retrace: GC sweep failed: ${String(error)}`))
    return gcChain
  }

  async function sweepGcNow(sessionId) {
    if (!domain || !store) return
    // The sweep releases refs and deletes objects; it stays off until the
    // storage work package makes retention durable and namespace-scoped.
    if (!capabilities.artifactGc) return
    const now = Date.now()
    const last = lastGc.get(sessionId) ?? 0
    if (now - last < GC_INTERVAL_MS) return
    lastGc.set(sessionId, now)
    const refcounts = domain.table('refcounts')
    const versiongit = domain.table('versiongit')
    const keep = new Set()
    let zeroRef = 0
    for (const [sha, record] of refcounts.entries()) {
      const refs = Array.isArray(record.refs) ? record.refs : []
      const kept = retainedRefs(refs)
      if (kept.length !== refs.length) {
        if (kept.length > 0) await refcounts.put(sha, { ...record, refs: kept })
        else await refcounts.delete(sha)
      }
      if (kept.length > 0) keep.add(sha)
      else zeroRef += 1
    }
    // Prune git facts only for versions we know were truncated; unknown
    // versions keep theirs so a cold session can still roll back.
    const retained = retainedUnion()
    const known = knownUnion()
    for (const versionId of [...versiongit.keys()]) {
      if (!retained.has(versionId) && known.has(versionId)) await versiongit.delete(versionId)
    }
    const removed = await gcArtifacts(store, keep, { minAgeMs: GC_GRACE_MS })
    if (removed > 0 || zeroRef > 0) log(`retrace: GC removed ${removed} objects (${zeroRef} zero-ref)`)
  }

  /**
   * Register the projection unit, open the domain and wire the change feed.
   * Idempotent; safe to call from apply.
   */
  function register() {
    if (registered) return
    registered = true
    ctx.inject(['sessionProjections', 'sessionQuery', 'storageDomain'], (seam) => {
      seamCtx = seam
      disposers.push(seam.sessionProjections.register(versionsProjectionDefinition))
      // P2.1 — the fork-map unit: pure fold (branch topology), no side effects.
      disposers.push(seam.sessionProjections.register(forkmapProjectionDefinition))
      disposers.push(
        seam.sessionProjections.onChanged((session, key, value, seq) => {
          if (key !== 'retrace/versions') return
          noteRetained(session.id, value.versions ?? [])
          const latest = value.versions.at(-1)
          if (!latest || latest.boundarySeq !== seq) return // only NEW boundaries
          // Ordered side effects: snapshots and git facts must land before the
          // sweep computes which refs are retained.
          void (async () => {
            await snapshotVersionFiles(session, latest)
            await recordVersionGit(session, latest)
            await sweepGc(session.id)
          })().catch((error) => log(`retrace: version side effects failed: ${String(error)}`))
        }),
      )
      // Domain open is async; versioning degrades to L1 if it fails.
      void seam.storageDomain
        .open(retraceDomainSpec)
        .then((opened) => {
          domain = opened
          const root = options.storeRoot ?? join(resolveDshHome(), 'dsh-retrace')
          store = createArtifactStore(root)
          disposers.push(() => void domain.close())
          const global = opened.global.get()
          if (global) {
            // Durable defaults; the domain schema spells the git switch
            // `gitEnabled` while consumers read `config.git`.
            durableGlobal = {}
            if (typeof global.retentionLimit === 'number') durableGlobal.retentionLimit = global.retentionLimit
            if (typeof global.gitEnabled === 'boolean') durableGlobal.git = global.gitEnabled
          }
        })
        .catch((error) => log(`retrace: versioning disabled: ${String(error)}`))
    })
    ctx.effect(() => () => {
      for (const dispose of disposers) dispose()
    }, 'dsh-retrace: versioning seam')
  }

  /** HTTP fallback channel: the live projection snapshot for one session. */
  function snapshot(sessionId) {
    return snapshotKey(sessionId, 'retrace/versions', { enabled: false, versions: [] })
  }

  /** HTTP fallback channel: the fork-map projection snapshot (P2.1). */
  function snapshotForkmap(sessionId) {
    return snapshotKey(sessionId, 'retrace/forkmap', { enabled: false, nodes: [], boundaries: [] })
  }

  function snapshotKey(sessionId, key, empty) {
    if (!available()) return empty
    const session = ctx.sessions.get(sessionId)
    if (!session) {
      const error = new Error(`session "${sessionId}" not found`)
      error.code = 'session-not-found'
      throw error
    }
    const cut = seamCtx.sessionProjections.snapshot(session)
    const value = cut.values[key]
    if (!value) return empty
    return { enabled: configFor(sessionId).versioning, ...value }
  }

  /** readEvent passthrough (timeline detail drawer). */
  async function readEvent(request) {
    if (!available()) {
      const error = new Error('versioning surface unavailable')
      error.code = 'versioning-unavailable'
      throw error
    }
    return seamCtx.sessionQuery.readEvent(request)
  }

  /** readSurface passthrough. */
  async function readSurface(sessionId) {
    if (!available()) {
      const error = new Error('versioning surface unavailable')
      error.code = 'versioning-unavailable'
      throw error
    }
    return seamCtx.sessionQuery.readSurface(sessionId)
  }

  /**
   * Lineage chain (A4): walk `header.parentSession` from the current session
   * up to the root. Read-only; used by the fork-map header card to show how
   * the session continues/forks from its ancestors.
   *
   * @param {string} sessionId - the session to start from.
   * @returns {Array<{id: string, parentId: string|null}>} child-first chain
   *   (index 0 = this session, last = root).
   */
  function lineage(sessionId) {
    const chain = []
    const seen = new Set()
    let current = sessionId
    while (typeof current === 'string' && current !== '' && !seen.has(current)) {
      seen.add(current)
      const session = ctx.sessions.get(current)
      const header = session?.header ?? {}
      chain.push({ id: current, parentId: header.parentSession ?? null })
      current = header.parentSession ?? null
    }
    return chain
  }

  /** The live agent for one session (rollback busy-guard). */
  function agentOf(sessionId) {
    return ctx.agents?.get?.(sessionId) ?? undefined
  }

  /** Resolve the content address of `<versionId>:<path>` (or null). */
  async function resolveSnapshot(versionId, path) {
    if (!domain || !store) return null
    const ref = refFor(versionId, path)
    const refcounts = domain.table('refcounts')
    for (const [sha, record] of refcounts.entries()) {
      if (record.refs && record.refs.includes(ref)) return sha
    }
    return null
  }

  /** Integrity-checked snapshot read (rollback restore path). */
  async function readSnapshot(sha) {
    if (!store) {
      const error = new Error('versioning surface unavailable')
      error.code = 'versioning-unavailable'
      throw error
    }
    return store.read(sha)
  }

  /** Git facts for one version (headHash recorded at its boundary). */
  async function gitHeadFor(versionId) {
    if (!domain) return null
    return domain.table('versiongit').get(versionId) ?? null
  }

  /** Repo status of the session workspace (null = not a repository). */
  async function gitStatus(sessionId) {
    const adapter = ensureGit()
    if (!adapter) return null
    const session = ctx.sessions.get(sessionId)
    const cwd = session?.header?.cwd
    if (typeof cwd !== 'string' || cwd.length === 0) return null
    return adapter.status(cwd)
  }

  /** `git checkout <headHash> -- <paths>` (write; caller confirms first). */
  async function gitCheckout(cwd, headHash, paths) {
    const adapter = ensureGit()
    if (!adapter) {
      const error = new Error('git adapter unavailable')
      error.code = 'versioning-unavailable'
      throw error
    }
    return adapter.checkout(cwd, headHash, paths)
  }

  /** One-click init for a non-repository workspace (write; caller confirms). */
  async function gitInit(sessionId) {
    const adapter = ensureGit()
    if (!adapter) {
      const error = new Error('git adapter unavailable')
      error.code = 'versioning-unavailable'
      throw error
    }
    const session = ctx.sessions.get(sessionId)
    const cwd = session?.header?.cwd
    if (typeof cwd !== 'string' || cwd.length === 0) {
      const error = new Error('session has no workspace cwd')
      error.code = 'no-cwd'
      throw error
    }
    // Sandboxed fs providers need the calling session's policy; the deployment
    // default has no workspace root and refuses the .gitignore write.
    let policy
    try {
      policy = typeof ctx.sandboxPolicy?.resolve === 'function' ? ctx.sandboxPolicy.resolve({ session }) : undefined
    } catch {
      policy = undefined
    }
    return adapter.init(cwd, undefined, policy)
  }

  /**
   * 压缩前体检（B1 短期 / 事故根因 3）：扫描会话内会破坏 token meter 的
   * turn-null marker（空 assistant/message replace，data.editor 存在）。
   * token meter 折叠要求 assistant/message 匹配打开的 step/start，而 retrace
   * 的编辑/撤回 marker 是 turn/step=null —— /compact 与压力测量永久失败。
   * 检测只读不写；清理由 /retrace-doctor 流程（本端点 + 用户确认）处理。
   */
  function doctorScan(sessionId) {
    if (!available()) return { enabled: false, markerCount: 0, markers: [] }
    const session = ctx.sessions.get(sessionId)
    if (!session) {
      const error = new Error(`session "${sessionId}" not found`)
      error.code = 'session-not-found'
      throw error
    }
    // Read through the shared reader: the current host exposes snapshotEvents()
    // and no `events` array, so `session.events` made every scan report an
    // empty history (a broken log must not look clean).
    let events
    try {
      events = sessionEvents(session)
    } catch (error) {
      const wrapped = new Error(`session log unavailable: ${error instanceof Error ? error.message : String(error)}`)
      wrapped.code = 'log-unavailable'
      throw wrapped
    }
    const t1 = localTokenMeterViolations(events)
    // New markers are user/message (current host) while legacy ones are
    // assistant/message; select by marker identity, not by event type.
    const markers = t1
      .filter((v) => v.id === 'T1' && isMarkerEvent(eventAt(events, v.seq)))
      .map((v) => ({ seq: v.seq, message: v.message }))
      .slice(0, 100)
    return { enabled: true, markerCount: markers.length, markers }
  }

  return {
    register,
    available,
    configFor,
    setConfig,
    capabilities: capabilitiesView,
    snapshot,
    snapshotForkmap,
    doctorScan,
    readEvent,
    readSurface,
    lineage,
    agentOf,
    resolveSnapshot,
    readSnapshot,
    gitHeadFor,
    gitStatus,
    gitCheckout,
    gitInit,
  }
}
