import { sessionEvents } from './host-core.js'

/**
 * dsh-retrace · lib/interrupt-guard.js
 * R4 中断轮次治理（2026-08-30 任务书 §4）。
 *
 * 目标：退出/关闭会话前对「未闭合 turn」的会话提示用户，避免误以为任务
 * 已干净结束。
 *
 * 设计（按实现方案 §R4，铁律「先核实官方 turn 关闭路径」）：
 *   - 官方 `dsh-agent-loop/lib/index.js:620` 在 finally 块保证 `turn/end`
 *     必然写入（含 reason.kind='error' 的中断）——正常退出/中断路径不会
 *     留下未闭合 turn；
 *   - 未闭合 turn 只出现在「崩溃 / 强杀 / 断电」场景：有 turn/start 无
 *     turn/end（interrupted/aborted 是官方正常闭合，不在此列）；
 *   - 因此本守卫**只检测 + 提示，绝不自动写 turn/end**（与官方持久化竞态
 *     会引入双写；且插件不应在运行期补写持久化事件——铁律「插件内不要
 *     删除/重编号持久化事件」的同类约束）。
 *
 * 检测函数：
 *   unclosedTurns(session) → { turn, state: 'open' }[]
 *     扫描会话事件：turn/start 开、turn/end 关；尾部仍开 = 未闭合。
 */

/**
 * 读会话事件。
 *
 * 当前宿主 Session 只暴露 `snapshotEvents()`，没有 `events` 属性——早先直接读
 * `session.events` 会让本守卫在真实会话上永远看到空数组（死代码）。这里复用
 * host-core 的统一读入口，并对退出路径做容错：dispose 时抛错比漏报更糟。
 * @param {object} session - DSH session 对象。
 * @returns {Array<object>}
 */
function eventsOf(session) {
  try {
    return sessionEvents(session)
  } catch {
    return []
  }
}

/**
 * 扫描会话，找未闭合的轮次。
 * @param {object} session - DSH session 对象（session.events 为事件数组）。
 * @returns {Array<{turn: number, state: 'open'}>}
 *
 * ⚠️ 判定（2026-08-31 独立审查修正）：只报**真正未闭合**的轮次——有
 * turn/start 且尾部没有对应 turn/end（崩溃/强杀现场）。
 * turn/end 的 reason.kind 为 'interrupted'/'aborted' 是官方**正常闭合**
 * （用户主动中断，agent-loop finally 保证写入），archive 实测 69 会话中
 * 666 aborted + 126 interrupted 全是正常闭合、真 open 只 10 个——把它们
 * 当"未闭合"会在每次退出对 91% 会话打误导性 warning。
 *
 * ⚠️ 2026-10-25 修复：此前用**单个** `openTurn` 变量——后一次 `turn/start`
 * 会覆盖前一次，任一 `turn/end` 又会把它整体清空。于是「崩溃后恢复、再次
 * 崩溃」这种最需要告警的现场（turn 1 从未闭合、turn 2 正常结束）反而
 * **一条都不报**（假阴性）；连续两次崩溃只报最后一轮。改为按 turn 号记账，
 * `turn/end` 只关闭对应那一轮。
 */
export function unclosedTurns(session) {
  const events = eventsOf(session)
  /** @type {Map<number, true>} 未闭合的具名轮次 */
  const open = new Map()
  /** 无 turn 号的历史事件（旧日志格式）：按 FIFO 配对 */
  let anonymous = 0
  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    if (event.type === 'turn/start') {
      const turn = event.data?.turn
      if (typeof turn === 'number') open.set(turn, true)
      else anonymous += 1
    } else if (event.type === 'turn/end') {
      const turn = event.data?.turn
      if (typeof turn === 'number') {
        open.delete(turn)
      } else if (anonymous > 0) {
        anonymous -= 1
      } else if (open.size > 0) {
        // turn/end 缺 turn 号：关闭最早开启的一轮，单轮场景与旧行为等价
        open.delete(open.keys().next().value)
      }
    }
  }
  // 尾部仍有未闭合 turn（崩溃/强杀现场）
  const found = [...open.keys()].map((turn) => ({ turn, state: 'open' }))
  for (let i = 0; i < anonymous; i++) found.push({ turn: undefined, state: 'open' })
  return found
}

/**
 * 挂载退出前提示：在插件 dispose 时对「当前 attach 且有未闭合轮次」的会话
 * 记录一条 warning（非阻断）。调用方（apply 的 ctx.effect 清理）负责在
 * 退出/重载时触发。
 *
 * 不做客户端弹窗（非阻断提示由宿主 UI 在会话内呈现——本插件只负责检测与
 * 日志；客户端时间线渲染未闭合轮次的提示属 UI 层，后续可扩展）。
 * @param {object} ctx - cordis ctx。
 * @param {(line: string) => void} log - 日志函数。
 * @param {() => Array<object>} [sessionList] - 活跃会话列表（默认 ctx.sessions）。
 */
export function attachExitWarning(ctx, log, sessionList) {
  return () => {
    const sessions = typeof sessionList === 'function' ? sessionList() : ctx?.sessions
    if (!sessions || typeof sessions !== 'object') return
    const ids = typeof sessions.keys === 'function' ? [...sessions.keys()] : Object.keys(sessions)
    for (const id of ids) {
      const session = typeof sessions.get === 'function' ? sessions.get(id) : sessions[id]
      if (!session) continue
      const unclosed = unclosedTurns(session)
      if (unclosed.length === 0) continue
      const summary = unclosed
        .map((u) => (typeof u.turn === 'number' ? `turn ${u.turn} (${u.state})` : `unnamed ${u.state} turn`))
        .join(', ')
      log(`retrace-interrupt-guard: 会话 ${id} 存在未闭合轮次 ${summary}——中断未干净收尾，重启后可能触发旧光标回放；建议退出前先体检（dsh-log-contract check）`)
    }
  }
}

/**
 * 在给定会话上运行检测（供 CLI/测试直接调用）。
 * @param {object} session - 会话对象或 { events: [...] }。
 * @returns {Array<{turn: number, state: string}>}
 */
export function detectUnclosed(session) {
  return unclosedTurns(session)
}
