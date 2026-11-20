import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_CONFIG } from '../src/config.js'
import { parseQuotePayload } from '../src/tencent.js'
import {
  KIND, compressAlerts, createTracker, evaluateBoards, evaluateQuotes, evaluateStockFlow, formatAlert, formatDigest,
} from '../src/rules.js'

const T = DEFAULT_CONFIG.thresholds

/** 一条最普通的报价，用 overrides 改出各种场景。 */
function quote(overrides = {}) {
  return {
    code: 'sh600360',
    name: '华微电子',
    price: 10,
    prevClose: 10,
    open: 10,
    high: 10,
    low: 10,
    pct: 0,
    amountWan: 10000,
    turnoverRate: 1,
    amplitude: 2,
    limitUp: 11,
    limitDown: 9,
    volRatio: 1,
    ts: '20261120103000',
    ...overrides,
  }
}

test('涨幅超过阈值触发涨幅异动，并在冷却期内不重复', () => {
  const tracker = createTracker()
  const now = 1_000_000
  const first = evaluateQuotes({ quotes: [quote({ price: 10.5, pct: 5, ts: '20261120103000' })], tracker, thresholds: T, now })
  assert.equal(first.alerts.length, 1)
  assert.equal(first.alerts[0].kind, KIND.CHANGE_UP)
  assert.match(first.alerts[0].detail, /10\.50/)

  const again = evaluateQuotes({ quotes: [quote({ price: 10.6, pct: 6, ts: '20261120103030' })], tracker: first.tracker, thresholds: T, now: now + 30_000 })
  assert.equal(again.alerts.length, 0, '冷却期内不应重复报警')

  const later = evaluateQuotes({ quotes: [quote({ price: 10.9, pct: 9, ts: '20261120104100' })], tracker: again.tracker, thresholds: T, now: now + T.cooldownMs + 1000 })
  assert.equal(later.alerts.length, 1, '冷却结束后可以再报')
})

test('跌幅超过阈值触发跌幅异动', () => {
  const result = evaluateQuotes({ quotes: [quote({ price: 9.5, pct: -5 })], tracker: createTracker(), thresholds: T, now: 1_000_000 })
  assert.equal(result.alerts[0].kind, KIND.CHANGE_DOWN)
})

test('窗口内急拉触发 surge，窗口不够长时不触发', () => {
  const samples = evaluateQuotes({ quotes: [quote({ price: 10 })], tracker: createTracker(), thresholds: T, now: 1_000_000 })
  const climbed = evaluateQuotes({
    quotes: [quote({ price: 10.3, ts: '20261120103100' })],
    tracker: samples.tracker,
    thresholds: T,
    now: 1_060_000,
  })
  const surge = climbed.alerts.find(alert => alert.kind === KIND.SURGE)
  assert.ok(surge, '60 秒内 3% 应该触发急拉')
  assert.match(surge.detail, /60 秒内 \+3\.0%/)

  // 只有 5 秒的跨度，不足以算急拉。
  const tooFast = evaluateQuotes({
    quotes: [quote({ price: 10.5, ts: '20261120103200' })],
    tracker: climbed.tracker,
    thresholds: T,
    now: 1_065_000,
  })
  assert.equal(tooFast.alerts.find(alert => alert.kind === KIND.SURGE), undefined)
})

test('急跳水触发 plunge', () => {
  const start = evaluateQuotes({ quotes: [quote({ price: 10 })], tracker: createTracker(), thresholds: T, now: 1_000_000 })
  const dropped = evaluateQuotes({
    quotes: [quote({ price: 9.7, ts: '20261120103100' })],
    tracker: start.tracker,
    thresholds: T,
    now: 1_060_000,
  })
  assert.ok(dropped.alerts.some(alert => alert.kind === KIND.PLUNGE))
})

test('涨停只报一次，炸板报一次', () => {
  const limit = quote({ price: 11, limitUp: 11, ts: '20261120103000' })
  const first = evaluateQuotes({ quotes: [limit], tracker: createTracker(), thresholds: T, now: 1_000_000 })
  assert.ok(first.alerts.some(alert => alert.kind === KIND.LIMIT_UP))

  const still = evaluateQuotes({ quotes: [quote({ price: 11, limitUp: 11, ts: '20261120103100' })], tracker: first.tracker, thresholds: T, now: 1_030_000 })
  assert.equal(still.alerts.filter(alert => alert.kind === KIND.LIMIT_UP).length, 0)

  const open = evaluateQuotes({ quotes: [quote({ price: 10.8, limitUp: 11, ts: '20261120103200' })], tracker: still.tracker, thresholds: T, now: 1_060_000 })
  assert.ok(open.alerts.some(alert => alert.kind === KIND.BROKEN_LIMIT))

  const back = evaluateQuotes({ quotes: [quote({ price: 11, limitUp: 11, ts: '20261120103300' })], tracker: open.tracker, thresholds: T, now: 1_090_000 })
  assert.equal(back.alerts.filter(alert => alert.kind === KIND.BROKEN_LIMIT).length, 0)
})

test('跌停触发一次 limit-down', () => {
  const result = evaluateQuotes({ quotes: [quote({ price: 9, limitDown: 9 })], tracker: createTracker(), thresholds: T, now: 1_000_000 })
  assert.equal(result.alerts.filter(alert => alert.kind === KIND.LIMIT_DOWN).length, 1)
})

test('量比放大且价格同向时触发放量', () => {
  const result = evaluateQuotes({ quotes: [quote({ price: 10.2, volRatio: 3.2, turnoverRate: 4 })], tracker: createTracker(), thresholds: T, now: 1_000_000 })
  assert.ok(result.alerts.some(alert => alert.kind === KIND.VOLUME))
})

test('量比高但价格没动不报放量', () => {
  const result = evaluateQuotes({ quotes: [quote({ price: 10.01, volRatio: 4 })], tracker: createTracker(), thresholds: T, now: 1_000_000 })
  assert.equal(result.alerts.length, 0)
})

test('低于价格下限的票被忽略', () => {
  const result = evaluateQuotes({ quotes: [quote({ price: 0.5, prevClose: 0.4, pct: 25 })], tracker: createTracker(), thresholds: T, now: 1_000_000 })
  assert.equal(result.alerts.length, 0)
})

test('板块涨跌幅突变触发板块异动', () => {
  const first = evaluateBoards({ boards: [{ code: 'pt1', name: '半导体产业', pct: -1, mainNetWan: 0 }], tracker: createTracker(), thresholds: T, now: 1_000_000 })
  assert.equal(first.alerts.length, 0, '第一轮只记录基线')
  const moved = evaluateBoards({ boards: [{ code: 'pt1', name: '半导体产业', pct: -4, mainNetWan: 0 }], tracker: first.tracker, thresholds: T, now: 1_030_000 })
  assert.equal(moved.alerts[0].kind, KIND.BOARD_CHANGE)
  assert.match(moved.alerts[0].detail, /-3\.0 个百分点/)
})

test('板块主力净流入突变触发板块资金', () => {
  const first = evaluateBoards({ boards: [{ code: 'pt1', name: '人工智能', pct: 0, mainNetWan: 10_000 }], tracker: createTracker(), thresholds: T, now: 1_000_000 })
  const moved = evaluateBoards({ boards: [{ code: 'pt1', name: '人工智能', pct: 0, mainNetWan: 90_000 }], tracker: first.tracker, thresholds: T, now: 1_030_000 })
  assert.equal(moved.alerts[0].kind, KIND.BOARD_FLOW)
  assert.match(moved.alerts[0].detail, /增加 8\.0 亿/)
})

test('个股主力净流入增量触发资金异动', () => {
  const first = evaluateStockFlow({ code: 'sh600360', name: '华微电子', mainNet: 10_000_000, tracker: createTracker(), thresholds: T, now: 1_000_000 })
  assert.equal(first.alerts.length, 0)
  const jump = evaluateStockFlow({ code: 'sh600360', name: '华微电子', mainNet: 210_000_000, tracker: first.tracker, thresholds: T, now: 1_030_000 })
  assert.equal(jump.alerts[0].kind, KIND.STOCK_FLOW)
  assert.match(jump.alerts[0].detail, /2\.0 亿/)
})

test('formatDigest 合并同一只票的多种异动', () => {
  const alerts = [
    { scope: 'stock', code: 'sh600360', name: '华微电子', kind: KIND.CHANGE_UP, label: '涨幅异动', detail: '现价 10.50，+5.0%', pct: 5 },
    { scope: 'stock', code: 'sh600360', name: '华微电子', kind: KIND.VOLUME, label: '放量', detail: '量比 3.2，+5.0%', pct: 5 },
    { scope: 'board', code: 'pt1', name: '芯片概念', kind: KIND.BOARD_CHANGE, label: '板块异动', detail: '涨跌幅 +2.0%' },
  ]
  const text = formatDigest(alerts, new Date(2026, 10, 20, 10, 32, 5).getTime())
  const lines = text.split('\n')
  assert.equal(lines.length, 3, '两条同票异动应合并成一行')
  assert.match(lines[0], /^\[科技股异动\] 2026-11-20 10:32:05$/)
  assert.match(lines[1], /涨幅异动.*放量/)
  assert.match(lines[2], /芯片概念 板块/)
})

test('formatAlert 去掉交易所前缀', () => {
  const line = formatAlert({ scope: 'stock', code: 'sz300308', name: '中际旭创', label: '急拉', detail: '现价 100.00', pct: 3.2 })
  assert.match(line, /中际旭创\(300308\)/)
})

test('parseQuotePayload 解析腾讯真实报文', () => {
  const payload = 'v_sh600360="1~华微电子~600360~9.01~8.19~8.04~1376701~412339~964361~9.01~70283~9.00~1149~8.99~407~8.98~209~8.97~30~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~~20261120161445~0.82~10.01~9.01~8.04~9.01/1376701/1229042006~1376701~122904~14.34~47.06~~9.01~8.04~11.84~86.52~86.52~2.43~9.01~7.37~5.13~72078~8.93~40.45~50.05";'
  const [parsed] = parseQuotePayload(payload)
  assert.equal(parsed.code, 'sh600360')
  assert.equal(parsed.name, '华微电子')
  assert.equal(parsed.price, 9.01)
  assert.equal(parsed.prevClose, 8.19)
  assert.equal(parsed.ts, '20261120161445')
  assert.equal(parsed.limitUp, 9.01)
  assert.equal(parsed.limitDown, 7.37)
  assert.equal(parsed.volRatio, 5.13)
  assert.equal(parsed.turnoverRate, 14.34)
})

test('parseQuotePayload 跳过停牌（价格为 0）', () => {
  const payload = 'v_sh600360="1~停牌股~600360~0.00~8.19~0~0~0~0";'
  assert.equal(parseQuotePayload(payload).length, 0)
})

test('compressAlerts 把同类大量异动合成一条群体提示', () => {
  const many = Array.from({ length: 9 }, (_, index) => ({
    scope: 'stock', code: `sz00${index}`, name: `跌股${index}`, kind: KIND.CHANGE_DOWN,
    label: '跌幅异动', detail: '现价 10.00，-5.0%', pct: -5 - index,
  }))
  const [group] = compressAlerts(many, { groupThreshold: 5, maxAlerts: 12 })
  assert.equal(group.scope, 'group')
  assert.equal(group.name, '科技股')
  assert.match(group.detail, /^9 只同向异动/)
  assert.equal(compressAlerts(many, { groupThreshold: 5, maxAlerts: 12 }).length, 1)
})

test('compressAlerts 数量不多时保持逐条，且按严重度排序', () => {
  const alerts = [
    { scope: 'stock', code: 'sh1', name: '甲', kind: KIND.VOLUME, label: '放量', detail: '', pct: 5 },
    { scope: 'stock', code: 'sh2', name: '乙', kind: KIND.LIMIT_UP, label: '涨停', detail: '', pct: 10 },
  ]
  const kept = compressAlerts(alerts, { groupThreshold: 5, maxAlerts: 12 })
  assert.equal(kept.length, 2)
  assert.equal(kept[0].kind, KIND.LIMIT_UP, '涨停应排在放量前面')
})

test('compressAlerts 截断到单轮上限', () => {
  const alerts = Array.from({ length: 20 }, (_, index) => ({
    scope: 'stock', code: `sh${index}`, name: `股${index}`, kind: KIND.VOLUME, label: '放量', detail: '', pct: 3,
  }))
  // 每条 kind 相同会先被合成群体；改用不同 kind 制造 20 个独立桶。
  const distinct = alerts.map((alert, index) => ({
    ...alert,
    kind: `custom-${index}`,
    label: `类型${index}`,
    scope: index % 2 === 0 ? 'stock' : 'board',
  }))
  const kept = compressAlerts(distinct, { groupThreshold: 5, maxAlerts: 12 })
  assert.equal(kept.length, 12)
})
