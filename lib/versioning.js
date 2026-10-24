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
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import {
  REF_SEPARATOR,
  createArtifactStore,
  gcArtifacts,
  parseRef,
  parseVersionKey,
  refFor,
  retraceDomainSpec,
  versionKey,
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
/** 一次边界最多抓这么多文件 / 字节，防止大改动把整个工作区读一遍。 */
const MAX_FILES_PER_BOUNDARY = 32
const MAX_BYTES_PER_BOUNDARY = 16 * 1024 * 1024
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

  /**
   * One serialization chain per object address. Two files with identical content
   * snapshot concurrently and both read-modify-write the same refcounts row;
   * without the chain the second write drops the first reference and its object
   * becomes an orphan.
   */
  const shaChains = new Map()
  function withSha(sha256, work) {
    const previous = shaChains.get(sha256) ?? Promise.resolve()
    const run = previous.then(work)
    const settled = run.catch(() => {})
    shaChains.set(sha256, settled)
    void settled.then(() => {
      if (shaChains.get(sha256) === settled) shaChains.delete(sha256)
    })
    return run
  }

  /** Snapshots still writing their references; a sweep waits for them first. */
  const inflightSnapshots = new Set()
  function trackSnapshot(promise) {
    inflightSnapshots.add(promise)
    void promise.then(
      () => inflightSnapshots.delete(promise),
      () => inflightSnapshots.delete(promise),
    )
    return promise
  }
  async function settleSnapshots() {
    while (inflightSnapshots.size > 0) await Promise.allSettled([...inflightSnapshots])
  }

  /** sessionId → newest observed boundary and the paths it touched. */
  const latestBoundary = new Map()

  /**
   * A boundary snapshot reads the workspace after the fact, so its bytes are
   * only provable while no later boundary touched the same path first. When one
   * did, the reference is marked racy and restore refuses it.
   */
  function isRacyCapture(sessionId, record, path) {
    const latest = latestBoundary.get(sessionId)
    if (!latest || !(latest.seq > record.boundarySeq)) return false
    return latest.paths.has(path)
  }

  /** Read one touched file through the sandboxed fs and snapshot it. */
  async function snapshotOne(session, record, file) {
    const cwd = session.header?.cwd
    if (typeof cwd !== 'string' || cwd.length === 0) return 0
    let saved = null
    try {
      const target = await ctx.fs.resolve(file.path, { cwd })
      const workspaceTarget = await ctx.fs.resolve('.', { cwd })
      if (!ctx.fs.contains(workspaceTarget, target)) return 0 // outside the workspace
      const bytes = await ctx.fs.readBytes(target, undefined, MAX_SNAPSHOT_BYTES)
      if (isBinary(bytes)) return 0
      saved = await store.save(bytes)
      const sha256 = saved.sha256
      const ref = refFor(session.id, record.versionId, file.path)
      const racy = isRacyCapture(session.id, record, file.path)
      const refsTable = domain.table('refcounts')
      await withSha(sha256, async () => {
        const prev = refsTable.get(sha256)
        if (!prev) {
          await refsTable.put(sha256, {
            refs: [ref],
            sizeBytes: saved.sizeBytes,
            createdAt: typeof record.createdAt === 'number' ? record.createdAt : Date.now(),
            ...(racy ? { racy: [ref] } : {}),
          })
          return
        }
        const refs = Array.isArray(prev.refs) ? prev.refs : []
        const racyRefs = Array.isArray(prev.racy) ? prev.racy : []
        const addRef = !refs.includes(ref)
        const addRacy = racy && !racyRefs.includes(ref)
        if (!addRef && !addRacy) return
        await refsTable.put(sha256, {
          ...prev,
          refs: addRef ? [...refs, ref] : refs,
          ...(addRacy ? { racy: [...racyRefs, ref] } : {}),
        })
      })
      return saved.sizeBytes ?? 0
    } catch (error) {
      // A brand-new object whose reference never landed is an orphan: no row
      // can account for it, so drop the bytes now instead of leaking them.
      if (saved && !saved.existed) await store.remove(saved.sha256).catch(() => {})
      log(`retrace: snapshot skipped for ${file.path}: ${String(error)}`)
    }
    return 0
  }

  /** Side effect: snapshot every non-deleted touched file of a new version. */
  async function snapshotVersionFiles(session, record) {
    if (!domain || !store || !configFor(session.id).versioning) return
    // Boundary-time capture reads the workspace after the fact, so the bytes are
    // only provable while no later boundary touched the same path (see isRacyCapture).
    if (!capabilities.artifactCapture) return
    const files = record.touchedFiles.filter((file) => file.mode !== 'deleted')
    const limit = Math.min(files.length, MAX_FILES_PER_BOUNDARY)
    let bytes = 0
    let taken = 0
    for (let index = 0; index < limit; index += 1) {
      if (bytes >= MAX_BYTES_PER_BOUNDARY) break
      bytes += await trackSnapshot(snapshotOne(session, record, files[index])).catch(() => 0)
      taken += 1
    }
    if (taken < files.length) {
      log(`retrace: snapshot budget reached for ${record.versionId}, ${files.length - taken} file(s) skipped`)
    }
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
      await domain.table('versiongit').put(versionKey(session.id, record.versionId), {
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

  /** Union of retained `<sessionId>|<versionId>` keys across sessions. */
  function retainedUnion() {
    const retained = new Set()
    for (const [sessionId, ids] of retainedVersions) {
      for (const id of ids) retained.add(`${sessionId}${REF_SEPARATOR}${id}`)
    }
    return retained
  }

  /** Union of `<sessionId>|<versionId>` keys this process has observed. */
  function knownUnion() {
    const known = new Set()
    for (const [sessionId, ids] of knownVersions) {
      for (const id of ids) known.add(`${sessionId}${REF_SEPARATOR}${id}`)
    }
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
      const parsed = parseRef(ref)
      // Pre-namespace rows: the owning session is unknown, so they are never
      // released. Deleting unattributable data is exactly the failure the audit
      // found; keeping a few stale blobs is the cheap side of that trade.
      if (parsed.legacy) return true
      const key = `${parsed.sessionId}${REF_SEPARATOR}${parsed.versionId}`
      return retained.has(key) || !known.has(key)
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
    // Never reason about references that are still being written: an in-flight
    // snapshot may have published its object and not yet added its ref.
    await settleSnapshots()
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
    for (const key of [...versiongit.keys()]) {
      const parsed = parseVersionKey(key)
      if (parsed.legacy) continue // unattributable row: keep it
      const composite = `${parsed.sessionId}${REF_SEPARATOR}${parsed.versionId}`
      if (!retained.has(composite) && known.has(composite)) await versiongit.delete(key)
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
          // Remember what this boundary touched: an in-flight snapshot of an
          // earlier boundary whose path shows up here can no longer be proven.
          latestBoundary.set(session.id, {
            seq: latest.boundarySeq,
            paths: new Set((latest.touchedFiles ?? []).map((file) => file.path)),
          })
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

  /**
   * Resolve one reference: the content address plus whether the capture is
   * provably boundary-bound. Restore paths must use this (not the bare address)
   * so racy bytes are refused instead of written.
   */
  async function snapshotState(sessionId, versionId, path) {
    if (!domain || !store) return null
    const ref = refFor(sessionId, versionId, path)
    const refcounts = domain.table('refcounts')
    for (const [sha, record] of refcounts.entries()) {
      if (record.refs && record.refs.includes(ref)) {
        return { sha256: sha, racy: Array.isArray(record.racy) && record.racy.includes(ref) }
      }
    }
    return null
  }

  /** Resolve the content address of one (session, version, path) triple. */
  async function resolveSnapshot(sessionId, versionId, path) {
    const state = await snapshotState(sessionId, versionId, path)
    return state?.sha256 ?? null
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
  async function gitHeadFor(sessionId, versionId) {
    if (!domain) return null
    return domain.table('versiongit').get(versionKey(sessionId, versionId)) ?? null
  }

  /**
   * Read-only inventory of the artifact store: what the plugin actually holds,
   * how much of it predates the session namespace, and how many objects are
   * unreferenced. Diagnostics only — it never deletes anything.
   */
  async function storageInventory() {
    if (!domain || !store) return { enabled: false }
    const refcounts = domain.table('refcounts')
    const versiongit = domain.table('versiongit')
    let refs = 0
    let legacyRefs = 0
    let bytes = 0
    for (const [, record] of refcounts.entries()) {
      for (const ref of Array.isArray(record.refs) ? record.refs : []) {
        refs += 1
        if (parseRef(ref).legacy) legacyRefs += 1
      }
      bytes += typeof record.sizeBytes === 'number' ? record.sizeBytes : 0
    }
    let versionRows = 0
    let legacyVersionRows = 0
    for (const key of versiongit.keys()) {
      versionRows += 1
      if (parseVersionKey(key).legacy) legacyVersionRows += 1
    }
    const objects = await store.list()
    const referenced = new Set()
    for (const [sha, record] of refcounts.entries()) {
      if (Array.isArray(record.refs) && record.refs.length > 0) referenced.add(sha)
    }
    let orphans = 0
    for (const sha of objects) if (!referenced.has(sha)) orphans += 1
    return {
      enabled: true,
      objects: objects.length,
      refs,
      legacyRefs,
      versionRows,
      legacyVersionRows,
      bytes,
      orphans,
    }
  }

  /**
   * Append one audit line for an executed operation. Ids, scope and per-file
   * status only — never message text or file contents. Failures are logged, not
   * thrown: the operation already happened and the caller must see its result.
   */
  async function recordOperation(entry) {
    const root = options.storeRoot ?? join(resolveDshHome(), 'dsh-retrace')
    try {
      await mkdir(root, { recursive: true })
      await appendFile(join(root, 'operations.jsonl'), `${JSON.stringify(entry)}\n`, 'utf8')
    } catch (error) {
      log(`retrace: operation log failed: ${String(error)}`)
    }
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
  async function gitInit(sessionId, options = {}) {
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
    // A repository-creating write is only performed on explicit confirmation:
    // the HTTP route is reachable from any page in this origin.
    if (options.confirm !== true) {
      const error = new Error('git init requires explicit confirmation')
      error.code = 'confirm-required'
      throw error
    }
    // Sandboxed fs providers need the calling session's policy; the deployment
    // default has no workspace root and refuses the .gitignore write. Resolving
    // it must fail closed — an unproven policy silently downgrades the write.
    let policy
    try {
      if (typeof ctx.sandboxPolicy?.resolve !== 'function') throw new Error('sandbox policy resolver missing')
      policy = ctx.sandboxPolicy.resolve({ session })
      if (!policy) throw new Error('sandbox policy resolved to nothing')
    } catch (error) {
      const wrapped = new Error(`sandbox policy unavailable: ${error instanceof Error ? error.message : String(error)}`)
      wrapped.code = 'sandbox-policy-unavailable'
      throw wrapped
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
    snapshotState,
    recordOperation,
    readSnapshot,
    storageInventory,
    gitHeadFor,
    gitStatus,
    gitCheckout,
    gitInit,
  }
}
