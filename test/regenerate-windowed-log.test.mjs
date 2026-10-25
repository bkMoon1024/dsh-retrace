/**
 * 回归测试：窗口化事件日志下的 regenerate。
 *
 * 宿主把 `session.events` 暴露成**日志窗口** `log[seq - baseSeq]`，
 * 而 `session.surface.nodes` 里存的是**绝对 seq**。所以 `events[seq]`
 * 只在 `baseSeq === 0` 时成立（见 `lib/host-core.js` 的 `eventAt` 注释，
 * 以及 `AGENTS.md` 的同一约定）。
 *
 * `regenerate` 曾经用 `events[nodes[i]]` 直接下标找轮首，在 baseSeq > 0 的
 * 会话里会：
 *   1. 取到 undefined → 报 `no-prompt`，regenerate 完全不可用；或
 *   2. 取到错行 → 把**另一个消息的文本**当成 prompt 重发，并把 marker 的
 *      targetSeq 指到错误的消息上。
 *
 * 这里用假的 sessions/agents 直接驱动 `createEditorApi`，断言真正重发的
 * 文本与 marker 的 targetSeq。不需要跑起 host。
 *
 * 运行：node --test test/
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { createEditorApi } from '../lib/host-core.js'

/**
 * Build a fake session whose event log is windowed: `events[i].seq === i + baseSeq`.
 *
 * @param {number} baseSeq - the first seq present in this window (> 0 makes the
 *   window offset visible; 0 reproduces a full log).
 */
function makeSession(baseSeq) {
  // Four events, all inside the window: user A, assistant aA, user B, assistant aB.
  const events = [
    {
      seq: baseSeq + 0,
      type: 'user/message',
      data: { id: 'u-A', source: { kind: 'user' }, content: [{ type: 'text', text: '第一问' }] },
    },
    {
      seq: baseSeq + 1,
      type: 'assistant/message',
      data: { message: { id: 'a-A' }, content: [{ type: 'text', text: '答一' }] },
    },
    {
      seq: baseSeq + 2,
      type: 'user/message',
      data: { id: 'u-B', source: { kind: 'user' }, content: [{ type: 'text', text: '第二问' }] },
    },
    {
      seq: baseSeq + 3,
      type: 'assistant/message',
      data: { message: { id: 'a-B' }, content: [{ type: 'text', text: '答二' }] },
    },
  ]
  return {
    id: 's1',
    events,
    surface: { nodes: events.map((event) => event.seq) },
    header: { cwd: process.cwd() },
  }
}

/** Drive `regenerate` against a fake host and capture what it actually sent. */
async function runRegenerate(baseSeq, messageId) {
  const session = makeSession(baseSeq)
  const sessions = new Map([[session.id, session]])
  const sent = []
  const agents = new Map([
    [session.id, { status: 'idle', followup: (message) => sent.push(message) }],
  ])
  const markers = []
  const api = createEditorApi({}, sessions, agents, () => {}, {
    writeMarker: (target, span, payload) => {
      markers.push({ span, payload })
      return { seq: -1, data: { editor: {} } }
    },
  })
  const result = await api.regenerate({ sessionId: session.id, messageId })
  return { result, sent, markers }
}

test('完整日志（baseSeq=0）下 regenerate 重发最近的 user 输入', async () => {
  const { result, sent, markers } = await runRegenerate(0, 'a-B')
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(sent.length, 1)
  assert.equal(sent[0].content[0].text, '第二问')
  assert.equal(markers[0].payload.targetSeq, 2)
})

test('窗口化日志（baseSeq=1000）下 regenerate 仍能找到轮首并重发正确文本', async () => {
  const { result, sent, markers } = await runRegenerate(1000, 'a-B')
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(sent.length, 1)
  // 回归点：曾经这里是 undefined / 报 no-prompt，或重发别人的文本。
  assert.equal(sent[0].content[0].text, '第二问')
  assert.equal(markers[0].payload.targetSeq, 1002)
})

test('窗口化日志下 marker 的 targetSeq 指向真正的 user 输入，而不是相邻节点', async () => {
  // baseSeq=1 时绝对 seq（1..4）恰好都落在数组下标范围内，旧实现的
  // events[nodes[i]] 会静默取到错行而不是 undefined —— 这是更危险的一支。
  const { result, markers } = await runRegenerate(1, 'a-B')
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(markers[0].payload.targetSeq, 3)
  assert.deepEqual(markers[0].span.shadowedSeqs, [3, 4])
})

test('窗口化日志下 editAndResend 的原始文本也按绝对 seq 读取', async () => {
  const session = makeSession(1000)
  const sessions = new Map([[session.id, session]])
  const sent = []
  const agents = new Map([
    [session.id, { status: 'idle', followup: (message) => sent.push(message) }],
  ])
  const api = createEditorApi({}, sessions, agents, () => {}, {
    writeMarker: () => ({ seq: -1, data: { editor: {} } }),
  })
  const result = await api.editAndResend({ sessionId: session.id, messageId: 'u-B', text: '改写后的第二问' })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(sent[0].content[0].text, '改写后的第二问')
})
