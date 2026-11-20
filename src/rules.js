/**
 * 异动判定。全部是纯函数：给定报价、历史跟踪器和阈值，返回命中列表与新跟踪器。
 * 这样判定逻辑可以脱离网络和 Cordis 单独测试。
 */

/** 个股异动类型。 */
export const KIND = {
  CHANGE_UP: 'change-up',
  CHANGE_DOWN: 'change-down',
  SURGE: 'surge',
  PLUNGE: 'plunge',
  VOLUME: 'volume',
  LIMIT_UP: 'limit-up',
  LIMIT_DOWN: 'limit-down',
  BROKEN_LIMIT: 'broken-limit',
  /** 板块级：涨跌幅突变。 */
  BOARD_CHANGE: 'board-change',
  /** 板块级：主力净流入突变。 */
  BOARD_FLOW: 'board-flow',
  /** 个股级：主力净流入突变。 */
  STOCK_FLOW: 'stock-flow',
}

const LABELS = {
  [KIND.CHANGE_UP]: '涨幅异动',
  [KIND.CHANGE_DOWN]: '跌幅异动',
  [KIND.SURGE]: '急拉',
  [KIND.PLUNGE]: '跳水',
  [KIND.VOLUME]: '放量',
  [KIND.LIMIT_UP]: '涨停',
  [KIND.LIMIT_DOWN]: '跌停',
  [KIND.BROKEN_LIMIT]: '炸板',
  [KIND.BOARD_CHANGE]: '板块异动',
  [KIND.BOARD_FLOW]: '板块资金',
  [KIND.STOCK_FLOW]: '主力资金',
}

/** 样本保留 10 分钟，足够算窗口涨速又不至于无限增长。 */
const SAMPLE_KEEP_MS = 10 * 60 * 1000

/** 建一个空跟踪器。 */
export function createTracker() {
  return { symbols: {}, boards: {} }
}

function entryOf(tracker, code) {
  const existing = tracker.symbols[code]
  if (existing !== undefined) return existing
  return { samples: [], everLimitUp: false, everLimitDown: false, brokenAlerted: false, lastAlertAt: {} }
}

function cooldownAllows(entry, kind, now, cooldownMs) {
  const last = entry.lastAlertAt[kind] ?? 0
  return now - last >= cooldownMs
}

function pctOf(quote) {
  if (quote.prevClose > 0) return ((quote.price - quote.prevClose) / quote.prevClose) * 100
  return quote.pct
}

/** 百分比保留一位小数，用于文案。 */
function one(value) {
  return (Math.round(value * 10) / 10).toFixed(1)
}

function money(wan) {
  const abs = Math.abs(wan)
  if (abs >= 10000) return `${(wan / 10000).toFixed(1)} 亿`
  return `${Math.round(wan)} 万`
}

function moneyFromYuan(yuan) {
  return money(yuan / 10000)
}

/**
 * 判定一批个股快照。
 * @param {object} input
 * @param {Array<object>} input.quotes - gtimg 解析出的快照。
 * @param {object} input.tracker - {@link createTracker} 的返回值。
 * @param {object} input.thresholds - 阈值。
 * @param {number} input.now - 当前毫秒。
 * @returns {{ alerts: Array<object>, tracker: object }}
 */
export function evaluateQuotes({ quotes, tracker, thresholds, now }) {
  const symbols = { ...tracker.symbols }
  const alerts = []
  const cooldownMs = thresholds.cooldownMs

  for (const quote of quotes) {
    if (!(quote.price >= thresholds.minPrice)) continue
    const previous = entryOf({ symbols }, quote.code)
    const entry = {
      // 样本元素也复制一份，保证不就地修改上一版跟踪器。
      samples: previous.samples.map(sample => ({ ...sample })),
      everLimitUp: previous.everLimitUp,
      everLimitDown: previous.everLimitDown,
      brokenAlerted: previous.brokenAlerted,
      lastAlertAt: { ...previous.lastAlertAt },
    }

    // 样本：同一报价时间戳且同价视为同一条，只更新时间，避免重复轮询把窗口算虚。
    const last = entry.samples[entry.samples.length - 1]
    if (last !== undefined && last.ts === quote.ts && last.price === quote.price) {
      last.t = now
    } else {
      entry.samples.push({ t: now, ts: quote.ts, price: quote.price })
    }
    entry.samples = entry.samples.filter(sample => now - sample.t <= SAMPLE_KEEP_MS)

    const pct = pctOf(quote)
    const push = (kind, detail) => {
      if (!cooldownAllows(entry, kind, now, cooldownMs)) return
      entry.lastAlertAt[kind] = now
      alerts.push({
        scope: 'stock',
        code: quote.code,
        name: quote.name,
        kind,
        label: LABELS[kind],
        detail,
        price: quote.price,
        pct,
        boards: quote.boards,
      })
    }

    // 涨停 / 跌停 / 炸板。
    const atLimitUp = quote.limitUp > 0 && quote.price >= quote.limitUp - 0.005
    const atLimitDown = quote.limitDown > 0 && quote.price <= quote.limitDown + 0.005
    if (atLimitUp) {
      if (!entry.everLimitUp) push(KIND.LIMIT_UP, `封板 ${quote.limitUp.toFixed(2)}`)
      entry.everLimitUp = true
    } else if (entry.everLimitUp && !entry.brokenAlerted && quote.limitUp > 0) {
      entry.brokenAlerted = true
      push(KIND.BROKEN_LIMIT, `涨停打开，现价 ${quote.price.toFixed(2)}（涨停 ${quote.limitUp.toFixed(2)}）`)
    }
    if (atLimitDown) {
      if (!entry.everLimitDown) push(KIND.LIMIT_DOWN, `封板 ${quote.limitDown.toFixed(2)}`)
      entry.everLimitDown = true
    }

    // 涨跌幅。
    if (Math.abs(pct) >= thresholds.changePct) {
      push(pct > 0 ? KIND.CHANGE_UP : KIND.CHANGE_DOWN, `现价 ${quote.price.toFixed(2)}，${pct > 0 ? '+' : ''}${one(pct)}%`)
    }

    // 窗口内急拉 / 跳水。
    const windowMs = Math.max(1000, thresholds.speedWindowSec * 1000)
    const windowStart = now - windowMs
    const base = entry.samples.find(sample => sample.t >= windowStart)
    if (base !== undefined) {
      const span = now - base.t
      if (span >= Math.min(windowMs * 0.5, 20000) && base.price > 0) {
        const move = ((quote.price - base.price) / base.price) * 100
        if (move >= thresholds.speedPct) {
          push(KIND.SURGE, `${Math.round(span / 1000)} 秒内 +${one(move)}%，现价 ${quote.price.toFixed(2)}`)
        } else if (move <= -thresholds.speedPct) {
          push(KIND.PLUNGE, `${Math.round(span / 1000)} 秒内 ${one(move)}%，现价 ${quote.price.toFixed(2)}`)
        }
      }
    }

    // 放量：量比或换手显著抬升，且价格同向配合。
    const volumeRatioHit = quote.volRatio >= thresholds.volumeRatio && Math.abs(pct) >= 1
    const turnoverHit = quote.turnoverRate >= thresholds.turnoverRate && Math.abs(pct) >= 2
    if (volumeRatioHit || turnoverHit) {
      const parts = []
      if (quote.volRatio > 0) parts.push(`量比 ${quote.volRatio.toFixed(1)}`)
      if (quote.turnoverRate > 0) parts.push(`换手 ${quote.turnoverRate.toFixed(1)}%`)
      parts.push(`${pct > 0 ? '+' : ''}${one(pct)}%`)
      push(KIND.VOLUME, parts.join('，'))
    }

    symbols[quote.code] = entry
  }

  return { alerts, tracker: { ...tracker, symbols } }
}

/**
 * 个股主力资金增量。由 monitor 在拉到新浪资金流后调用。
 * @param {object} input - code/name/mainNet(元)/tracker/thresholds/now。
 */
export function evaluateStockFlow({ code, name, mainNet, tracker, thresholds, now }) {
  const symbols = { ...tracker.symbols }
  const previous = entryOf({ symbols }, code)
  const entry = { ...previous, lastAlertAt: { ...previous.lastAlertAt } }
  const alerts = []
  const lastNet = previous.flowNet
  entry.flowNet = mainNet
  if (typeof lastNet === 'number') {
    const delta = mainNet - lastNet
    if (Math.abs(delta) >= thresholds.stockFlowYuan && cooldownAllows(entry, KIND.STOCK_FLOW, now, thresholds.cooldownMs)) {
      entry.lastAlertAt[KIND.STOCK_FLOW] = now
      alerts.push({
        scope: 'stock',
        code,
        name,
        kind: KIND.STOCK_FLOW,
        label: LABELS[KIND.STOCK_FLOW],
        detail: `主力净流入 ${moneyFromYuan(mainNet)}（增加 ${moneyFromYuan(delta)}）`,
        pct: 0,
      })
    }
  }
  symbols[code] = entry
  return { alerts, tracker: { ...tracker, symbols } }
}

/**
 * 板块级判定：涨跌幅突变与板块主力净流入突变。
 */
export function evaluateBoards({ boards, tracker, thresholds, now }) {
  const state = { ...tracker.boards }
  const alerts = []
  for (const board of boards) {
    const previous = state[board.code] ?? { lastAlertAt: {} }
    const entry = { ...previous, lastAlertAt: { ...previous.lastAlertAt } }
    if (typeof previous.pct === 'number') {
      const delta = board.pct - previous.pct
      if (Math.abs(delta) >= thresholds.boardChangePct && Math.abs(board.pct) >= 2
        && cooldownAllows(entry, KIND.BOARD_CHANGE, now, thresholds.cooldownMs)) {
        entry.lastAlertAt[KIND.BOARD_CHANGE] = now
        alerts.push({
          scope: 'board',
          code: board.code,
          name: board.name,
          kind: KIND.BOARD_CHANGE,
          label: LABELS[KIND.BOARD_CHANGE],
          detail: `涨跌幅 ${one(board.pct)}%（${delta > 0 ? '+' : ''}${one(delta)} 个百分点）`,
        })
      }
    }
    if (typeof previous.mainNetWan === 'number') {
      const delta = board.mainNetWan - previous.mainNetWan
      if (Math.abs(delta) >= thresholds.boardFlowWan
        && cooldownAllows(entry, KIND.BOARD_FLOW, now, thresholds.cooldownMs)) {
        entry.lastAlertAt[KIND.BOARD_FLOW] = now
        alerts.push({
          scope: 'board',
          code: board.code,
          name: board.name,
          kind: KIND.BOARD_FLOW,
          label: LABELS[KIND.BOARD_FLOW],
          detail: `主力净流入 ${money(board.mainNetWan)}（增加 ${money(delta)}）`,
        })
      }
    }
    entry.pct = board.pct
    entry.mainNetWan = board.mainNetWan
    state[board.code] = entry
  }
  return { alerts, tracker: { ...tracker, boards: state } }
}

/** 把一条异动渲染成一行文本。 */
export function formatAlert(alert) {
  const tag = `【${alert.label}】`
  if (alert.scope === 'group') return `${tag}${alert.name} ${alert.detail}`
  if (alert.scope === 'board') return `${tag}${alert.name} 板块 ${alert.detail}`
  const code = String(alert.code ?? '').replace(/^(sh|sz|bj)/, '')
  const pct = typeof alert.pct === 'number' && alert.pct !== 0 ? `（${alert.pct > 0 ? '+' : ''}${one(alert.pct)}%）` : ''
  return `${tag}${alert.name}(${code})${pct} ${alert.detail}`
}

/** 异动的严重程度，用于单轮截断时保留最重要的那几条。 */
export function severityOf(alert) {
  // 群体条是全局判断，比个股的涨跌幅更该留在前几条里。
  if (alert.scope === 'group' && (alert.kind === KIND.CHANGE_UP || alert.kind === KIND.CHANGE_DOWN)) return 0.5
  switch (alert.kind) {
    case KIND.LIMIT_UP:
    case KIND.LIMIT_DOWN:
    case KIND.BROKEN_LIMIT: return 0
    case KIND.SURGE:
    case KIND.PLUNGE: return 1
    case KIND.BOARD_CHANGE:
    case KIND.BOARD_FLOW: return 2
    case KIND.CHANGE_UP:
    case KIND.CHANGE_DOWN: return 3
    default: return 4
  }
}

/**
 * 把一轮命中压成有限条消息：同类过多时合成一条群体提示，再按严重度截断。
 * @param {Array<object>} alerts - 本轮命中。
 * @param {object} options - groupThreshold / maxAlerts。
 * @returns {Array<object>} 压缩后的异动列表。
 */
export function compressAlerts(alerts, { groupThreshold = 5, maxAlerts = 12 } = {}) {
  if (alerts.length === 0) return []
  const buckets = new Map()
  for (const alert of alerts) {
    const key = `${alert.scope}:${alert.kind}`
    const bucket = buckets.get(key)
    if (bucket === undefined) buckets.set(key, [alert])
    else bucket.push(alert)
  }
  const kept = []
  // 涨跌停、炸板这类离散强信号逐条保留，但一轮只留前几条，剩下的折成一条汇总，
  // 免得普跌日十几只跌停把涨幅、急拉这些更有信息量的信号全挤掉。
  const neverGroup = new Set([KIND.LIMIT_UP, KIND.LIMIT_DOWN, KIND.BROKEN_LIMIT])
  const limitKeep = 3
  for (const bucket of buckets.values()) {
    if (bucket[0].scope !== 'stock') {
      kept.push(...bucket)
      continue
    }
    if (neverGroup.has(bucket[0].kind)) {
      kept.push(...bucket.slice(0, limitKeep))
      if (bucket.length > limitKeep) {
        kept.push({
          scope: 'group',
          code: bucket[0].code,
          name: '科技股',
          kind: bucket[0].kind,
          label: bucket[0].label,
          detail: `另有 ${bucket.length - limitKeep} 只${bucket[0].label}`,
          pct: bucket[0].pct,
        })
      }
      continue
    }
    if (bucket.length <= groupThreshold) {
      kept.push(...bucket)
      continue
    }
    const ranked = bucket
      .filter(alert => alert.scope === 'stock')
      .sort((a, b) => Math.abs(b.pct ?? 0) - Math.abs(a.pct ?? 0))
    const lead = ranked.slice(0, 3).map(alert => `${alert.name} ${alert.pct > 0 ? '+' : ''}${one(alert.pct ?? 0)}%`).join('、')
    const sample = bucket[0]
    kept.push({
      scope: 'group',
      code: sample.code,
      name: '科技股',
      kind: sample.kind,
      label: sample.label,
      detail: `${bucket.length} 只同向异动${lead === '' ? '' : `，代表：${lead}`}`,
      pct: sample.pct,
    })
  }
  return kept.sort((a, b) => severityOf(a) - severityOf(b)).slice(0, maxAlerts)
}

/** 把一批异动合成一条消息；同一只票的多种异动合并到一行。 */
export function formatDigest(alerts, now) {
  const stamp = new Date(now)
  const pad = value => String(value).padStart(2, '0')
  const head = `[科技股异动] ${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())} `
    + `${pad(stamp.getHours())}:${pad(stamp.getMinutes())}:${pad(stamp.getSeconds())}`
  const byKey = new Map()
  for (const alert of alerts) {
    const key = alert.scope === 'board' ? `board:${alert.code}` : alert.code
    const existing = byKey.get(key)
    if (existing === undefined) byKey.set(key, { alert, extra: [] })
    else existing.extra.push(alert)
  }
  const lines = []
  for (const { alert, extra } of byKey.values()) {
    const merged = { ...alert }
    if (extra.length > 0) merged.detail = `${alert.detail}；${extra.map(item => `${item.label} ${item.detail}`).join('；')}`
    lines.push(formatAlert(merged))
  }
  return [head, ...lines].join('\n')
}
