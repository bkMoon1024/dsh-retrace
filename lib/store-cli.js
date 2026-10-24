/**
 * 产物库离线检查与清理（工作包 I）。
 *
 * 为什么需要：0.4.58 之前写进 `refcounts` 的引用没有会话前缀（`v12:src/a.ts`），
 * 归属无法可靠恢复，所以这些 legacy 引用永远不会被自动 GC 命中，也不会被任何
 * 会话查到——它们只是长期占着磁盘和元数据。这个模块提供只读盘点 + 只删「无人引用」
 * 对象的清理，供 `retrace store` 子命令使用。
 *
 * 安全边界（刻意保守）：
 *  - 只删除「磁盘上存在、但任何引用（含 legacy）都不指向」的对象；
 *  - 有引用的对象、legacy 引用指向的对象，一律不动；
 *  - 引用存在而对象缺失（悬空引用）只报告，不修，因为无法判断该丢引用还是找文件；
 *  - 默认 dry-run，`--apply` 必须再带 `--yes`。
 */
import { readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const SHA = /^[0-9a-f]{64}$/

/** 读取 DSH storageDomain 落盘文件（缺失时返回空结构）。 */
export function readDomain(file) {
  let raw = null
  try { raw = readFileSync(file, 'utf8') } catch { return { refcounts: new Map(), versiongit: new Map(), present: false } }
  const parsed = JSON.parse(raw)
  const tables = parsed?.tables ?? {}
  return {
    present: true,
    refcounts: new Map(Object.entries(tables.refcounts ?? {})),
    versiongit: new Map(Object.entries(tables.versiongit ?? {})),
    global: parsed?.global ?? null,
  }
}

/** 列出对象库里的 blob（`objects/<2位>/<sha>`）。 */
export function listObjects(root) {
  const out = []
  let buckets = []
  try { buckets = readdirSync(join(root, 'objects')) } catch { return out }
  for (const bucket of buckets) {
    if (!/^[0-9a-f]{2}$/.test(bucket)) continue
    let names = []
    try { names = readdirSync(join(root, 'objects', bucket)) } catch { continue }
    for (const name of names) {
      if (!SHA.test(name)) continue
      const path = join(root, 'objects', bucket, name)
      let size = 0
      try { size = statSync(path).size } catch { size = 0 }
      out.push({ sha: name, path, size })
    }
  }
  return out
}

/** 引用分类：`<sessionId>|v12:path` 为 scoped，`v12:path` 为 legacy。 */
export function classifyRef(ref) {
  const bar = ref.indexOf('|')
  const colon = ref.indexOf(':')
  if (bar !== -1 && (colon === -1 || bar < colon)) {
    return { scoped: true, sessionId: ref.slice(0, bar), versionId: ref.slice(bar + 1, colon === -1 ? undefined : colon) }
  }
  return { scoped: false, sessionId: null, versionId: colon === -1 ? ref : ref.slice(0, colon) }
}

/**
 * 盘点：对象、引用、悬空、孤儿、legacy 统计。
 * `verifyHashes` 为 true 时逐个校验对象内容 sha（慢，默认关）。
 */
export function inventory({ domainFile, root, verifyHashes = false }) {
  const domain = readDomain(domainFile)
  const objects = listObjects(root)
  const referenced = new Set()
  const dangling = []
  const legacyRefs = []
  const scopedRefs = []
  const zeroRefRows = []
  let refBytes = 0
  for (const [sha, record] of domain.refcounts) {
    const refs = Array.isArray(record?.refs) ? record.refs : []
    refBytes += Number(record?.sizeBytes ?? 0)
    if (refs.length === 0) { zeroRefRows.push(sha); continue }
    for (const ref of refs) {
      const parsed = classifyRef(ref)
      if (parsed.scoped) scopedRefs.push({ sha, ref, sessionId: parsed.sessionId, versionId: parsed.versionId })
      else legacyRefs.push({ sha, ref, versionId: parsed.versionId })
      referenced.add(sha)
    }
  }
  const onDisk = new Set(objects.map((object) => object.sha))
  for (const sha of referenced) if (!onDisk.has(sha)) dangling.push(sha)
  const orphans = objects.filter((object) => !referenced.has(object.sha))
  const mismatched = []
  if (verifyHashes) {
    for (const object of objects) {
      let bytes = null
      try { bytes = readFileSync(object.path) } catch { continue }
      if (createHash('sha256').update(bytes).digest('hex') !== object.sha) mismatched.push(object.sha)
    }
  }
  return {
    domainPresent: domain.present,
    objects,
    objectBytes: objects.reduce((sum, object) => sum + object.size, 0),
    refRows: domain.refcounts.size,
    zeroRefRows,
    scopedRefs,
    legacyRefs,
    dangling,
    orphans,
    mismatched,
    versionRows: domain.versiongit.size,
    legacyVersionRows: [...domain.versiongit.keys()].filter((key) => !key.includes('|')).length,
    refBytes,
  }
}

/**
 * 删除孤儿对象。只接受 inventory 算出的 orphans（调用方不得自行传 sha）。
 * 返回 { removed, bytes, failed }。
 */
export function pruneOrphans(report) {
  let removed = 0
  let bytes = 0
  const failed = []
  for (const object of report.orphans) {
    try {
      unlinkSync(object.path)
      removed += 1
      bytes += object.size
    } catch (error) {
      failed.push({ sha: object.sha, message: String(error?.message ?? error) })
    }
  }
  return { removed, bytes, failed }
}
