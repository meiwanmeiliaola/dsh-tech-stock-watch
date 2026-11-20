// 收盘后的端到端冒烟：建池 → 拉真实报价 → 跑判定 → 打印推送文本。
import { resolveConfig } from '../src/config.js'
import { Monitor } from '../src/monitor.js'

const config = resolveConfig({})
const pushed = []
const monitor = new Monitor({
  config,
  deliver: text => { pushed.push(text); return true },
  log: { info: m => console.log('[info]', m), warn: m => console.log('[warn]', m) },
})

console.time('buildUniverse+scan')
await monitor.refreshUniverse()
console.timeEnd('buildUniverse+scan')

const universe = monitor.universe
console.log('板块:', universe.boards.map(b => b.name).join('、'))
console.log('池子:', universe.symbols.length, '/ 扫描', universe.scanned)
console.log('前 5 只:', universe.symbols.slice(0, 5).map(s => `${s.name}(${s.code}) 成交额 ${s.amountWan} 万`).join(' | '))

console.time('scan')
const { count, ranked, alerts, hitCount } = await monitor.scanOnce({ limit: 8 })
console.timeEnd('scan')
console.log('报价条数:', count)
console.log('--- 最强 8 只 ---')
for (const item of ranked) console.log(`${item.name}(${item.code}) ${item.price} ${item.pct.toFixed(2)}% 量比 ${item.volRatio} 换手 ${item.turnoverRate}% [${item.boards.join('/')}]`)

console.log('--- 判定结果 ---')
console.log(`原始命中 ${hitCount} 条，压缩后 ${alerts.length} 条（扫描不推送）`)
for (const alert of alerts) console.log(`- [${alert.label}] ${alert.name} ${alert.detail}`)
monitor.stop()
