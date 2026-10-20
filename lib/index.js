/**
 * dsh-retrace — Host plugin entry (published form).
 *
 * Registers the retrace operations behind two transports so the same
 * package serves both the desktop/web GUI and headless deployments:
 *
 *  - `harness.handle` when present (the dynamic-package RPC bridge), and
 *  - a same-origin HTTP route under `/api/plugins/retrace/*` for
 *    bundled (published) client modules.
 *
 * The HTTP surface additionally serves the P0 versioning channels:
 * `GET /versions` (projection snapshot fallback), `GET /event` and
 * `GET /surface` (lazy sessionQuery reads). The versioning seam itself
 * (`lib/versioning.js`) lives behind `ctx.inject(...)` — headless
 * compositions without the projection/storage services simply degrade to
 * plain L1 (recall / edit / regenerate), exactly like 0.2.x.
 *
 * Every op resolves to a result object `{ ok: true, value }` /
 * `{ ok: false, error }` produced by the host core, so both transports carry
 * the identical wire shape.
 */
import { createEditorApi } from './host-core.js'
import { createRetraceHttpHandler, ROUTE_PREFIX } from './http.js'
import { createVersioningSeam } from './versioning.js'
import { createRollbackExecutor } from './rollback.js'
import { createMarkerGuard } from './prewrite-guard.js'
import { createWatchdog } from './watchdog.js'
import { attachExitWarning } from './interrupt-guard.js'
import { sessionBadge as fnvBadge } from './badge.js'
import { dshAdapter, semanticBadgeOf } from './adapter/dsh.js'
import { createDshMarkerWriter } from './adapter/dsh-writer.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/**
 * 语义短码（2026-09-01 对齐修复线定稿规则）：优先查 `会话短码表.json`
 * （工作区+序号+父子语义，如 op065op016），命中即返回；否则 FNV 兜底。
 * 短码表由 `tools/gen-session-codes.mjs` 生成（基于 header.createdAt + parentSession）。
 */
const BADGE_TABLE_PATH = join(homedir(), 'opena-archive-2026-08', '会话短码表.json')
let badgeTable = null
try {
  badgeTable = JSON.parse(readFileSync(BADGE_TABLE_PATH, 'utf8')).codes ?? null
} catch { /* 表缺失时 FNV 兜底 */ }
/**
 * 会话短码(2026-09-02 v2,三级):
 * ① archive 短码表(修复线维护,固定);
 * ② 实时推导(工作区 createdAt 序号+父链,与 gen-session-codes.mjs 同规则,
 *    表的新鲜超集——新 fork 会话也能得到语义短码);
 * ③ FNV-1a 确定性兜底(任何环境可复现,人机交互最低保障)。
 */
async function sessionBadge(sessionId) {
  const semantic = badgeTable?.[sessionId]
  if (typeof semantic === 'string' && semantic.length > 0) return semantic
  try {
    const derived = await semanticBadgeOf(sessionId)
    if (derived) return derived
  } catch { /* 推导失败 → FNV 兜底 */ }
  return fnvBadge(sessionId)
}

export const name = 'dsh-retrace'
export const inject = ['sessions', 'agents', 'webServer', 'fs', 'subprocess', 'sandboxPolicy']

export function apply(ctx) {
  const log = (line) => ctx.logger?.info(line)

  // P0 versioning seam: projection unit + artifact snapshots + config view.
  const seam = createVersioningSeam(ctx, log)
  seam.register()

  // 写前校验守卫（8-25 事故闭环）：marker 落盘前过三层契约；依赖缺失自动降级。
  const guard = createMarkerGuard({
    log,
    enabled: (sessionId) => seam.configFor(sessionId).prewrite !== false,
  })
  // 遮蔽写入器（2026-09-02 抽象设计落地）：业务层表达「遮蔽这些消息」，
  // DSH 的 turn/step 翻译（三情形/计数器推进/窗口化防御）隔离在 adapter。
  const markerWriter = createDshMarkerWriter({
    agents: ctx.agents,
    validateMarker: guard.validateMarkerAppend,
    // 情形② step 号从文件全量算（host 窗口化内存不可信，1e99e1ff 复盘 §五）
    readMaxStep: async (sessionId, turn) => dshAdapter.maxStepInTurnFromFile(sessionId, turn),
    log,
  })
  const hooks = { validateMarker: guard.validateMarkerAppend, writeMarker: markerWriter.writeMarker }

  // P1 rollback executor: context/artifact restore over the seam (git + snapshots).
  const rollback = createRollbackExecutor({ ctx, sessions: ctx.sessions, agents: ctx.agents, seam, validateMarker: hooks.validateMarker, writeMarker: hooks.writeMarker, log })

  const api = createEditorApi(ctx, ctx.sessions, ctx.agents, log, hooks)

  // ── 会话短码 / 标题 / 水位（HTTP 与 harness 桥共用）─────────────────────────
  // 0.4.x 里这些操作只挂在 harness 桥上；发布桌面模式没有 `harness` 全局，
  // 整块桥是 no-op，于是短码/标题/水位在桌面版全部失效（HTTP 404）。
  // 现在抽到装配层，两条传输共用同一实现。
  /** 会话短码：只用于显示（0.4.56 起不再写进会话标题）。 */
  async function sessionBadgeOp(args) {
    const sessionId = String(args?.sessionId ?? '')
    return { ok: true, value: { sessionId, badge: await sessionBadge(sessionId) } }
  }

  /** 用户自定义会话名：只写纯标题，不再拼接短码（0.4.56）。 */
  async function setUserTitleOp(args) {
    const sessionId = String(args?.sessionId ?? '')
    const title = String(args?.title ?? '').trim()
    if (!sessionId) return { ok: false, error: { code: 'bad-request', message: 'sessionId required' } }
    if (!title) return { ok: false, error: { code: 'bad-request', message: 'title required' } }
    const session = ctx.sessions?.get?.(sessionId)
    if (!session) return { ok: false, error: { code: 'not-found', message: 'session not found' } }
    try {
      const titles = ctx.get?.('sessionTitle')
      if (titles && typeof titles.rename === 'function') titles.rename(session, title)
      else session.append('session/title', { title, source: { kind: 'user' } })
      return { ok: true, value: { title } }
    } catch (error) {
      return { ok: false, error: { code: 'internal', message: String(error) } }
    }
  }

  /** 会话水位体检 + 折叠建议（中文文案给正解）。 */
  async function waterLevelOp(args) {
    const sessionId = String(args?.sessionId ?? '')
    const level = await dshAdapter.waterLevelFromFile(sessionId, {
      window: Number(args?.window) || undefined,
    })
    if (!level) return { ok: false, error: { code: 'session-not-found', message: '会话文件不可读' } }
    const bandText = { green: '🟢 健康', yellow: '🟡 接近黄线', red: '🔴 超红线' }[level.band] ?? '?'
    const pctText = `${Math.round(level.pct * 100)}%`
    const adv = []
    if (level.band === 'green') {
      adv.push(`水位${bandText}(${pctText}),缓存红利中,无需动作。`)
    } else if (level.suggestion) {
      const s = level.suggestion
      adv.push(`水位${bandText}(${pctText}),余量约 ${Math.round(level.remaining / 10000)} 万 token。`)
      adv.push(`建议折叠最早完成块(seq ${s.foldRange.start}..${s.foldRange.end},${s.foldRange.rounds} 轮),释放约 ${s.gainTokens} token,折叠后水位降至约 ${Math.round(s.afterPct * 100)}%。`)
      if (level.band === 'red') adv.push('红线前必须已折(官方自动压缩会折头部=缓存全断);若仍逼近,请 fork 续聊。')
    }
    return { ok: true, value: { ...level, advice: adv.join('\n') } }
  }

  const badgeOps = {
    sessionBadge: sessionBadgeOp,
    setUserTitle: setUserTitleOp,
    waterLevel: waterLevelOp,
  }

  const handler = createRetraceHttpHandler(ctx, {
    sessions: ctx.sessions,
    agents: ctx.agents,
    seam,
    rollback,
    hooks,
    badge: badgeOps,
    log,
  })

  const disposeRoute = (() => {
    const webServer = ctx.get('webServer')
    if (webServer && typeof webServer.register === 'function') {
      try {
        return webServer.register({
          kind: 'prefix',
          path: ROUTE_PREFIX,
          handler,
        })
      } catch (error) {
        ctx.logger?.warn(`dsh-retrace: route registration failed: ${String(error)}`)
      }
    }
    return () => {}
  })()

  // ── 历史标题清理（0.4.56）──────────────────────────────────────────────
  // 旧版本（≤0.4.55）把「[短码] 」写进了会话标题。短码改为只显示后，启动时经官方
  // sessionController 逐条 rename 还原：rename 会同时更新会话日志与投影缓存，侧边栏/
  // 标题栏立即刷新。冷会话会被 resume 一次（仅清理时发生）；失败只告警，下次启动重试。
  // 可用 DSH_RETRACE_NO_BADGE_CLEANUP=1 关闭。
  // 短码形态：语义短码「工作区2+序号+父工作区2+序号（或根 FF000）」或 10 位 FNV 兜底；
  // 不带 i 标志、不放宽到任意 [xxx]，避免误伤 "[ClaudeProtect]" 这类合法方括号标题。
  const BADGE_TITLE_PREFIX = /^\[(?:[a-z]{2}\d{1,5}(?:[a-z]{2}\d{1,5}|FF000)|[a-z0-9]{10})\]\s+/
  let badgeCleanupTask = null
  let badgeCleanupTimer = null
  function startBadgeTitleCleanup() {
    if (globalThis.process?.env?.DSH_RETRACE_NO_BADGE_CLEANUP === '1') return true
    if (badgeCleanupTask !== null) return true
    let controller = null
    try { controller = ctx.get?.('sessionController') ?? null } catch { controller = null }
    if (!controller || typeof controller.list !== 'function' || typeof controller.rename !== 'function') return false
    badgeCleanupTask = (async () => {
      let restored = 0
      let failed = 0
      let items = []
      try {
        const result = await controller.list({})
        items = Array.isArray(result?.items) ? result.items : []
      } catch (error) {
        log(`retrace: 短码标题清理读取列表失败: ${String(error).slice(0, 160)}`)
        return
      }
      for (const item of items) {
        const sessionId = String(item?.sessionId ?? '')
        const title = typeof item?.projections?.values?.title === 'string' ? item.projections.values.title : ''
        if (!sessionId || title === '') continue
        const clean = title.replace(BADGE_TITLE_PREFIX, '')
        if (clean === title || clean.length === 0) continue
        try {
          await controller.rename({ sessionId, title: clean })
          restored += 1
        } catch (error) {
          failed += 1
          log(`retrace: 标题还原失败 ${sessionId.slice(0, 26)}: ${String(error).slice(0, 160)}`)
        }
      }
      if (restored > 0 || failed > 0) log(`retrace: 短码标题清理完成：还原 ${restored} 个，失败 ${failed} 个`)
    })().finally(() => { badgeCleanupTask = null })
    return true
  }
  function scheduleBadgeCleanup(attempt = 0) {
    badgeCleanupTimer = setTimeout(() => {
      badgeCleanupTimer = null
      if (!startBadgeTitleCleanup() && attempt < 20) scheduleBadgeCleanup(attempt + 1)
    }, attempt === 0 ? 2500 : 3000)
  }
  const disposeBadgeCleanup = () => {
    if (badgeCleanupTimer !== null) { clearTimeout(badgeCleanupTimer); badgeCleanupTimer = null }
  }
  scheduleBadgeCleanup()

  // Dynamic-package bridge: no-op when this file runs as a plain published plugin.
  const disposeHarness = (() => {
    if (typeof harness === 'undefined' || !harness || typeof harness.handle !== 'function') return () => {}

    // 2026-09-01:操作前从文件算遮蔽(绕开 host 稀疏 session.events,用户方案)
    const withFileSpan = (op, modeOf) => async (args) => {
      // 情形② step 号:writer 的 readMaxStep 已在装配时注入(index.js createDshMarkerWriter
      // 闭包,从文件全量算)——不再经 args 传递(3e2262a 下沉后 writer 是唯一消费方)。
      try {
        // fold 用 args.start(range 起点);其余 op 用 seq/messageId。
        const target = op === 'fold' ? Number(args?.start) : (typeof args?.seq === 'number' ? args.seq : args?.messageId)
        if (target !== undefined && target !== null && !args?.span) {
          const spec = modeOf(args)
          const mode = typeof spec === 'string' ? spec : spec?.mode
          const endSeq = typeof spec === 'object' && spec ? spec.endSeq : undefined
          const span = await dshAdapter.spanFromFile(args.sessionId, target, mode, endSeq !== undefined ? { endSeq } : undefined)
          log(`retrace: spanFromFile(op=${op} target=${String(target).slice(0, 24)} mode=${mode}) → ${span ? `${span.shadowedSeqs.length} seqs` : 'null(fallback)'}`)
          if (span) args = { ...args, span }
        } else {
          log(`retrace: spanFromFile skipped(op=${op} target=${String(target).slice(0, 24)} hasSpan=${!!args?.span})`)
        }
      } catch (error) { log(`retrace: spanFromFile wrapper error: ${String(error).slice(0, 120)}`) }
      return api[op](args)
    }
    const disposers = [
      // 2026-09-07:recall 语义 = 遮蔽目标轮及之后全部(编辑=从此处分叉,bfb965e4/
      // 3f9e4f12 issue 要求)——不再只遮蔽目标轮(缺陷①断层);tail 在官方 foldSurface
      // nodes 上按位置切(ISSUE-20260907113201 修复),大范围遮蔽由快照点守卫引导分支。
      harness.handle('retrace.recall', withFileSpan('recall', () => 'tail')),
      harness.handle('retrace.editAndResend', withFileSpan('editAndResend', (a) => (a?.fromScratch ? 'tail' : 'round'))),
      harness.handle('retrace.regenerate', withFileSpan('regenerate', () => 'round')),
      // 三段式窗口批1:fold 完成块区间(marker 折叠承载,range mode)
      // 三段式批4:waterLevel(会话水位体检 + 折叠建议,中文文案给正解)
      harness.handle('retrace.waterLevel', waterLevelOp),
      // 三段式批3:unfold(视图层展开数据,从日志读被遮蔽内容,模型上下文不变)
      harness.handle('retrace.unfold', async (args) => {
        const markerSeq = Number(args?.markerSeq)
        if (!Number.isInteger(markerSeq) || markerSeq < 0) {
          return { ok: false, error: { code: 'bad-request', message: 'unfold 需要 fold marker 的 seq' } }
        }
        const content = await dshAdapter.unfoldContentFromFile(String(args?.sessionId ?? ''), markerSeq)
        if (!content) return { ok: false, error: { code: 'marker-not-found', message: '指定 seq 不是 retrace-fold- 折叠 marker 或无遮蔽内容' } }
        return { ok: true, value: content }
      }),
      harness.handle('retrace.fold', (async (args) => {
        const withSpan = withFileSpan('fold', (a) => ({ mode: 'range', endSeq: Number(a?.end) }))
        // fold 摘要:从文件生成(确定摘要,批2)注入 args.summary
        if (!args?.summary) {
          const start = Number(args?.start)
          const end = Number(args?.end)
          if (Number.isInteger(start) && Number.isInteger(end)) {
            try {
              const summary = await dshAdapter.summaryFromFile(args.sessionId, start, end)
              if (summary) args = { ...args, summary }
            } catch { /* 摘要失败不阻断折叠(空 content) */ }
          }
        }
        return withSpan(args)
      })),
      // 会话短码（2026-08-31）：session id → 确定性 10 位短码，人机交互识别用。
      harness.handle('retrace.sessionBadge', sessionBadgeOp),
      // 用户自定义会话名称（0.4.56 起只写纯标题，不再拼接短码）。
      harness.handle('retrace.setUserTitle', setUserTitleOp),
    ]
    return () => disposers.forEach((dispose) => dispose())
  })()

  // R1 实时看门狗：轮询文件尾部 seq vs 内存长度，捕获并发写入/旧光标回放现场。
  // 2.0.x 的内存事件可能窗口化（长度与文件 seq 不可比），默认关闭，仅诊断时开。
  const watchdog = createWatchdog(ctx, log, { enabled: globalThis.process?.env?.DSH_RETRACE_WATCHDOG === '1' })

  // R4 中断轮次治理：退出/重载时对未闭合 turn 会话提示（只检测不写事件）。
  const warnUnclosed = attachExitWarning(ctx, log)

  ctx.effect(() => () => {
    disposeRoute()
    disposeHarness()
    watchdog.dispose()
    warnUnclosed()
    disposeBadgeCleanup()
  }, 'dsh-retrace: transports')
}
