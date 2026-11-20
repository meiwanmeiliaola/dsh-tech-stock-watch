/**
 * 新浪个股资金流。
 *
 * 东财 push2 与腾讯 ff_ 在本机都不可用，新浪的 `MoneyFlow.ssl_qsfx_zjlrqs`
 * 仍然返回按日期排序的资金流：`r0_net` 是主力净流入（元），`netamount` 是总净流入。
 * 盘中当日行的数值会随成交刷新，用来观测主力净流入的增量。
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

/**
 * @param {string} code - 带交易所前缀，形如 "sh600360"。
 * @returns {Promise<{date: string, mainNet: number, net: number} | undefined>}
 */
export async function fetchFundFlow(code) {
  const url = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/MoneyFlow.ssl_qsfx_zjlrqs'
    + `?page=1&num=2&sort=opendate&asc=0&daima=${code}`
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, referer: 'https://finance.sina.com.cn/' },
      signal: AbortSignal.timeout(12000),
    })
    if (!res.ok) return undefined
    const rows = await res.json()
    const row = Array.isArray(rows) ? rows[0] : undefined
    if (row === undefined) return undefined
    return {
      date: String(row.opendate ?? ''),
      mainNet: Number.parseFloat(row.r0_net) || 0,
      net: Number.parseFloat(row.netamount) || 0,
    }
  } catch {
    return undefined
  }
}
