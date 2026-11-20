/**
 * 腾讯行情数据源。
 *
 * 实测结论（2026-11 于本机）：
 * - `qt.gtimg.cn` 批量快照可用，GBK 编码，含量比、换手、涨停/跌停价、报价时间戳；
 * - `proxy.finance.qq.com` 板块排行与板块成分可用，UTF-8，成分自带涨速、量比、换手；
 * - 东方财富 push2 在本机被拒（curl 与 node 都连不上），因此不作为数据源。
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const GBK = new TextDecoder('gbk')
const QQ_BASE = 'https://proxy.finance.qq.com/cgi/cgi-bin'

/** 腾讯批量快照单次最多塞多少只（URL 长度与稳定性折中）。 */
export const MAX_CODES_PER_REQUEST = 100

async function get(url, timeoutMs = 12000) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, referer: 'https://gu.qq.com/' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
  return res
}

async function getJson(url, timeoutMs = 12000) {
  const res = await get(url, timeoutMs)
  const body = await res.json()
  if (body?.code !== 0) throw new Error(`腾讯接口返回 ${body?.code}: ${body?.msg ?? 'unknown'} (${url})`)
  return body.data ?? {}
}

function num(value) {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * 解析 `v_sh600360="1~名字~600360~9.01~8.19~...";` 形式的返回。
 * 字段下标按腾讯当前协议：3 现价、4 昨收、5 今开、30 时间、32 涨跌幅、
 * 33 最高、34 最低、37 成交额(万)、38 换手、43 振幅、44 流通市值、45 总市值、
 * 47 涨停价、48 跌停价、49 量比。
 */
export function parseQuotePayload(text) {
  const quotes = []
  const pattern = /v_([a-z]{2}\d{6})="([^"]*)"/g
  let match
  while ((match = pattern.exec(text)) !== null) {
    const code = match[1]
    const fields = match[2].split('~')
    const price = num(fields[3])
    if (price <= 0) continue // 停牌或无报价
    quotes.push({
      code,
      name: fields[1] ?? '',
      price,
      prevClose: num(fields[4]),
      open: num(fields[5]),
      high: num(fields[33]),
      low: num(fields[34]),
      pct: num(fields[32]),
      amountWan: num(fields[37]),
      turnoverRate: num(fields[38]),
      amplitude: num(fields[43]),
      floatCapYi: num(fields[44]),
      totalCapYi: num(fields[45]),
      limitUp: num(fields[47]),
      limitDown: num(fields[48]),
      volRatio: num(fields[49]),
      ts: (fields[30] ?? '').trim(),
    })
  }
  return quotes
}

/** 拉一批股票快照。codes 形如 ["sh600360", "sz300308"]。 */
export async function fetchQuotes(codes, timeoutMs) {
  if (codes.length === 0) return []
  const url = `http://qt.gtimg.cn/q=${codes.join(',')}`
  const text = GBK.decode(await (await get(url, timeoutMs)).arrayBuffer())
  return parseQuotePayload(text)
}

/** 概念板块全量列表，含板块涨跌幅、涨速、主力净流入（万元）。 */
export async function fetchConceptBoards() {
  const rows = []
  for (let offset = 0; offset < 2000; offset += 200) {
    const data = await getJson(`${QQ_BASE}/rank/pt/getRank?board_type=gn&sort_type=price&direct=down&offset=${offset}&count=200&_appver=11.17.0`)
    const list = data.rank_list ?? []
    rows.push(...list)
    if (list.length < 200) break
  }
  return rows.map(row => ({
    code: row.code,
    name: row.name,
    pct: num(row.zdf),
    speed: num(row.speed),
    mainNetWan: num(row.zljlr),
  }))
}

/**
 * 一个板块按成交额排序后的成分股。
 * @param {string} boardCode - 形如 "pt02003891"。
 * @param {object} [options] - pages 返回前几页，count 每页条数。
 */
export async function fetchBoardConstituents(boardCode, options = {}) {
  const pages = options.pages ?? 1
  const count = Math.min(options.count ?? 200, 200)
  const rows = []
  for (let page = 0; page < pages; page += 1) {
    const data = await getJson(`${QQ_BASE}/rank/hs/getBoardRankList?board_code=${boardCode}&sort_type=turnover&direct=down&offset=${page * count}&count=${count}&_appver=11.17.0`)
    const list = data.rank_list ?? []
    rows.push(...list)
    if (list.length < count) break
  }
  return rows.map(row => ({
    code: row.code,
    name: row.name,
    price: num(row.zxj),
    pct: num(row.zdf),
    speed: num(row.speed),
    volRatio: num(row.lb),
    turnoverRate: num(row.hsl),
    amountWan: num(row.turnover),
    amplitude: num(row.zf),
  }))
}

/** 板块实时排行（只看板块本身，比拉全部成分便宜）。 */
export async function fetchBoardRank() {
  const data = await getJson(`${QQ_BASE}/rank/pt/getRank?board_type=gn&sort_type=price&direct=down&offset=0&count=200&_appver=11.17.0`)
  return (data.rank_list ?? []).map(row => ({
    code: row.code,
    name: row.name,
    pct: num(row.zdf),
    speed: num(row.speed),
    mainNetWan: num(row.zljlr),
  }))
}
