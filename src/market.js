/** 交易时段与报价新鲜度判断。全部按本机本地时间，部署在东八区即北京时间。 */

/** 把 "20261120161445" 解析成本地时间毫秒；无法解析返回 0。 */
export function parseQuoteTime(ts) {
  if (typeof ts !== 'string' || ts.length < 14) return 0
  const year = Number(ts.slice(0, 4))
  const month = Number(ts.slice(4, 6))
  const day = Number(ts.slice(6, 8))
  const hour = Number(ts.slice(8, 10))
  const minute = Number(ts.slice(10, 12))
  const second = Number(ts.slice(12, 14))
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return 0
  const value = new Date(year, month - 1, day, hour, minute, second).getTime()
  return Number.isFinite(value) ? value : 0
}

/** 报价的日期部分，形如 "20261120"。 */
export function quoteDay(ts) {
  return typeof ts === 'string' && ts.length >= 8 ? ts.slice(0, 8) : ''
}

/** 今天的日期串，形如 "20261120"。 */
export function todayKey(date = new Date()) {
  const year = String(date.getFullYear()).padStart(4, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}${month}${day}`
}

/** 是否落在配置的交易时段内（只看星期与时间，节假日靠报价新鲜度兜底）。 */
export function isTradingWindow(date = new Date(), windows) {
  const day = date.getDay()
  if (day === 0 || day === 6) return false
  const minutes = date.getHours() * 60 + date.getMinutes()
  return windows.some(([start, end]) => minutes >= start && minutes <= end)
}

/**
 * 报价是不是今天的、且足够新。
 * @param {string} ts - gtimg 的时间戳。
 * @param {number} now - 当前毫秒。
 * @param {number} staleAfterMs - 允许的时间落后上限。
 */
export function isFreshQuote(ts, now, staleAfterMs) {
  if (quoteDay(ts) !== todayKey(new Date(now))) return false
  const at = parseQuoteTime(ts)
  if (at === 0) return false
  return now - at <= staleAfterMs
}
