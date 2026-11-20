/** 股票池：把配置里的板块解析成代码，再拉成分、去重、按当日成交额截断。 */

import { fetchBoardConstituents, fetchConceptBoards } from './tencent.js'

/**
 * 把配置里的板块（字符串按名称、对象按 code 优先）解析成真实板块。
 * @param {Array<string|{code?: string, name?: string}>} wanted - 配置里的板块。
 * @returns {Promise<{boards: Array<object>, missing: Array<string>}>}
 */
export async function resolveBoards(wanted) {
  const list = Array.isArray(wanted) ? wanted : []
  if (list.length === 0) return { boards: [], missing: [] }
  const all = await fetchConceptBoards()
  const byCode = new Map(all.map(board => [board.code, board]))
  const byName = new Map(all.map(board => [board.name, board]))
  const boards = []
  const missing = []
  for (const item of list) {
    const spec = typeof item === 'string' ? { name: item } : item
    const found = (spec?.code !== undefined ? byCode.get(spec.code) : undefined)
      ?? (spec?.name !== undefined ? byName.get(spec.name) : undefined)
    if (found === undefined) {
      missing.push(spec?.name ?? spec?.code ?? String(item))
      continue
    }
    boards.push(found)
  }
  return { boards, missing }
}

/**
 * 构建股票池。
 * @param {object} config - 已解析的插件配置。
 * @param {{ info?: Function, warn?: Function }} [log] - 日志器，缺省静默。
 */
export async function buildUniverse(config, log) {
  const { boards, missing } = await resolveBoards(config.boards)
  if (missing.length > 0) log?.warn?.(`tech-stock-watch: 未找到板块 ${missing.join('、')}`)
  const symbols = new Map()
  let failures = 0
  for (const board of boards) {
    try {
      const rows = await fetchBoardConstituents(board.code, { pages: 1, count: 200 })
      for (const row of rows) {
        const existing = symbols.get(row.code)
        if (existing !== undefined) {
          existing.boards.push(board.name)
          continue
        }
        symbols.set(row.code, { ...row, boards: [board.name] })
      }
    } catch (error) {
      failures += 1
      log?.warn?.(`tech-stock-watch: 拉取板块 ${board.name} 成分失败：${String(error)}`)
    }
  }
  const ranked = [...symbols.values()].sort((a, b) => b.amountWan - a.amountWan)
  const kept = ranked.slice(0, Math.max(1, config.maxSymbols))
  log?.info?.(`tech-stock-watch: 股票池 ${kept.length} 只（共扫描 ${symbols.size} 只，${boards.length} 个板块）`)
  return { boards, symbols: kept, missing, failures, scanned: symbols.size }
}

/** 把股票池切成固定大小的分片，轮询用。 */
export function chunkSymbols(symbols, size) {
  const shards = []
  const step = Math.max(1, size)
  for (let index = 0; index < symbols.length; index += step) shards.push(symbols.slice(index, index + step))
  return shards
}
