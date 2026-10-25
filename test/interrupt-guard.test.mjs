import test from 'node:test'
import assert from 'node:assert/strict'
import { unclosedTurns } from '../lib/interrupt-guard.js'

const start = (turn) => ({ type: 'turn/start', data: turn === undefined ? {} : { turn } })
const end = (turn, kind = 'completed') => ({ type: 'turn/end', data: turn === undefined ? { reason: { kind } } : { turn, reason: { kind } } })
const sess = (...events) => ({ events })

test('单轮未闭合：报一轮', () => {
  assert.deepEqual(unclosedTurns(sess(start(1))), [{ turn: 1, state: 'open' }])
})

test('正常闭合：不报', () => {
  assert.deepEqual(unclosedTurns(sess(start(1), end(1))), [])
})

test('interrupted / aborted 属官方正常闭合：不报', () => {
  assert.deepEqual(unclosedTurns(sess(start(1), end(1, 'interrupted'))), [])
  assert.deepEqual(unclosedTurns(sess(start(1), end(1, 'aborted'))), [])
})

test('崩溃→恢复→再次崩溃：turn 1 从未闭合，必须报出来', () => {
  // 现场：turn 1 只 start 没 end（崩溃）；恢复后 turn 2 正常收尾。
  // 旧实现单个 openTurn 会被 turn 2 覆盖、再被 turn/end 清空 → 一条都不报。
  assert.deepEqual(unclosedTurns(sess(start(1), start(2), end(2))), [{ turn: 1, state: 'open' }])
})

test('连续两轮都未闭合：两轮都要报', () => {
  assert.deepEqual(unclosedTurns(sess(start(1), start(2))), [
    { turn: 1, state: 'open' },
    { turn: 2, state: 'open' },
  ])
})

test('乱序闭合：只关闭对应那一轮', () => {
  assert.deepEqual(unclosedTurns(sess(start(1), start(2), end(1))), [{ turn: 2, state: 'open' }])
})

test('旧日志无 turn 号：start/end 成对即闭合', () => {
  assert.deepEqual(unclosedTurns(sess(start(), end())), [])
  assert.deepEqual(unclosedTurns(sess(start())), [{ turn: undefined, state: 'open' }])
})

test('非对象事件与空会话不炸', () => {
  assert.deepEqual(unclosedTurns(sess(null, 1, 'x', start(1))), [{ turn: 1, state: 'open' }])
  assert.deepEqual(unclosedTurns(undefined), [])
})
