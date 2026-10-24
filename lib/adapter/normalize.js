/**
 * dsh-retrace — lib/adapter/normalize.js
 *
 * 事件信封的唯一读契约（read contract）。所有「读会话事件」的地方都必须经过
 * 这里，不要再在业务层各自猜字段形状。
 *
 * 为什么需要它：插件写过两代 marker。旧代（无 snapshotEvents 的宿主）是
 * `assistant/message` + `data.message.id` + `surfaceOp {op:'replace', start, end}`；
 * 现行宿主（0.1.7+，Session.snapshotEvents）要求 `user/message` + `data.id` +
 * `surfaceOp {op:'replace', startSeq, endSeq}`，且 assistant/message 不允许携带
 * sourceEventSeqs（官方 surface.js:232 起）。读端如果只认旧形状，就会出现
 * 「写进去了但读不出来」：版本分类退化成 edit、surface 折叠不 splice（与官方
 * foldSurface 分叉）、restore 守卫认不出自己写的 marker、doctor 把缺失字段当空历史。
 *
 * 本模块只做**形状归一**，不判断业务合法性——合法性由官方 Session 校验器负责，
 * 我们只保证「同一份日志，读出来的语义与官方 foldSurface 一致」。
 *
 * 纯函数、零依赖：可被投影 fold、CLI、测试在任意 realm 直接加载。
 */

/** 能进入 surface 的事件类型（与官方 isSurfaceEligibleType 同集合）。 */
export const SURFACE_EVENT_TYPES = new Set(['user/message', 'assistant/message', 'tool/result'])

/**
 * 新 marker 使用的 id 前缀。改名规则：换身份时必须保留旧前缀在
 * MARKER_ID_PREFIXES 里，否则历史 marker 会退化成通用 replace。
 */
export const MARKER_ID_PREFIX = 'retrace'

/** 本版本能分类的全部 marker 前缀（含历史身份 dsh-message-editor）。 */
export const MARKER_ID_PREFIXES = [MARKER_ID_PREFIX, 'message-editor']

/** 事件是否可进 surface 且带 surfaceOp 标记。 */
export function isSurfaceEvent(event) {
  return SURFACE_EVENT_TYPES.has(event?.type) && event?.surfaceOp !== undefined
}

/** 是否遮蔽了既有 surface 区间（append 是唯一的非替换操作）。 */
export function isReplacementSurfaceEvent(event) {
  return isSurfaceEvent(event) && event.surfaceOp !== 'append'
}

/**
 * 归一化 surfaceOp。
 * 旧形状 `{op:'replace', start, end}` / 新形状 `{op:'replace', startSeq, endSeq}` /
 * 追加 `'append'`。无法识别时返回 null（调用方按「无 surface 语义」处理，
 * 绝不猜一个区间出来）。
 *
 * @returns {{op:'append'}|{op:'replace', start:number, end:number}|null}
 */
export function surfaceOpOf(event) {
  const raw = event?.surfaceOp
  if (raw === undefined || raw === null) return null
  if (raw === 'append') return { op: 'append' }
  if (typeof raw !== 'object') return null
  if (raw.op !== 'replace') return null
  const start = Number.isSafeInteger(raw.startSeq) ? raw.startSeq : raw.start
  const end = Number.isSafeInteger(raw.endSeq) ? raw.endSeq : raw.end
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null
  return { op: 'replace', start, end }
}

/**
 * 事件的稳定消息 id。
 * user/message：`data.id`（现行）→ `data.message.id`（旧代 marker 把消息体套在 message 里）。
 * assistant/message：`data.message.id`（现行）→ `data.id`。
 */
export function messageIdOf(event) {
  const data = event?.data
  if (!data || typeof data !== 'object') return null
  if (event.type === 'user/message') {
    if (typeof data.id === 'string' && data.id.length > 0) return data.id
    if (typeof data.message?.id === 'string' && data.message.id.length > 0) return data.message.id
    return null
  }
  if (typeof data.message?.id === 'string' && data.message.id.length > 0) return data.message.id
  if (typeof data.id === 'string' && data.id.length > 0) return data.id
  return null
}

/** 插件 marker 的编辑器元数据（旧代在 assistant/message 的 data.editor）。 */
export function editorOf(event) {
  const editor = event?.data?.editor
  return editor && typeof editor === 'object' ? editor : null
}

/**
 * 事件的纯文本内容（两代消息体都覆盖）。
 * user/message：`data.content`；assistant/message：`data.message.content`。
 * 仅取 text block，用于 token 估算与折叠收益，不做渲染。
 */
export function messageTextOf(event) {
  const blocks = event?.type === 'user/message'
    ? event.data?.content
    : event?.type === 'assistant/message'
      ? event.data?.message?.content
      : undefined
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/** 事件遮蔽的 surface seq 列表：顶层 sourceEventSeqs 优先，data.shadowedSeqs 兜底。 */
export function shadowedSeqsOf(event) {
  const raw = event?.sourceEventSeqs
  if (Array.isArray(raw) && raw.length > 0) return raw.filter((seq) => Number.isSafeInteger(seq))
  const mirrored = event?.data?.shadowedSeqs
  if (Array.isArray(mirrored) && mirrored.length > 0) return mirrored.filter((seq) => Number.isSafeInteger(seq))
  return []
}

/** 轮边界 = 用户真正发出的消息（排除 context/steering 注入与插件 marker）。 */
export function isRoundBoundary(event) {
  return event?.type === 'user/message' && event?.data?.source?.kind === 'user'
}

/** marker id → 用户可见版本类型。未知前缀返回 null（不是「edit」）。 */
export function kindFromMarkerId(id) {
  if (typeof id !== 'string') return null
  for (const prefix of MARKER_ID_PREFIXES) {
    const head = `${prefix}-`
    if (!id.startsWith(head)) continue
    const op = id.slice(head.length).split('-')[0]
    if (op === 'recall' || op === 'edit' || op === 'regenerate' || op === 'restore') return op
    return null
  }
  return null
}

/** 压缩检查点来源（0.1.7+ `{kind:'compact-checkpoint'}` 或旧 `plugin: compact`）。 */
export function isCompactCheckpointSource(source) {
  return Boolean(source) && (source.kind === 'compact-checkpoint'
    || (source.kind === 'plugin' && source.plugin === 'compact'))
}

/**
 * 替换边界 → 版本类型。
 * 顺序：插件 marker（带 editor）→ 压缩检查点 → 通用 replace。
 * 旧实现用 `data.message.id` 判 marker，现行 marker 在 `data.id` 上，于是所有
 * recall 都退化成 edit——这里统一走 messageIdOf。
 */
export function classifyBoundaryKind(event) {
  if (editorOf(event)) return kindFromMarkerId(messageIdOf(event)) ?? 'edit'
  if (isCompactCheckpointSource(event?.data?.source)) return 'compaction'
  return 'replace'
}

/**
 * 会话是否由现行宿主提供（Session.snapshotEvents 是 0.1.7+ 的读接口）。
 * 用于「支持矩阵」判定：无法确认契约时业务层应转只读，而不是猜兼容。
 */
export function hasSnapshotEvents(session) {
  return typeof session?.snapshotEvents === 'function'
}

/**
 * 按 seq 取事件。
 *
 * 宿主的事件数组是「日志窗口」：`log[seq - baseSeq]`（dsh-session
 * Session.planEvent 用同一换算），所以 `events[seq]` 只在该会话 baseSeq=0
 * （完整日志）时成立。分叉/窗口化会话里直接下标会取到错行——撤回会算错范围、
 * 编辑会拿到别人的文本。这里用「下标命中校验 + 二分」消除假设。
 */
export function eventAt(events, seq) {
  if (!Array.isArray(events) || events.length === 0 || !Number.isSafeInteger(seq)) return undefined
  const direct = events[seq]
  if (direct !== undefined && direct?.seq === seq) return direct
  let low = 0
  let high = events.length - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    const value = events[mid]?.seq
    if (value === seq) return events[mid]
    if (typeof value !== 'number') return undefined
    if (value < seq) low = mid + 1
    else high = mid - 1
  }
  return undefined
}
