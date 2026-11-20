// 从真实股票池里取成交额最大的若干只，生成客户端面板的默认样本名单。
import { resolveConfig } from '../src/config.js'
import { Monitor } from '../src/monitor.js'

const monitor = new Monitor({ config: resolveConfig({}), deliver: () => true })
await monitor.refreshUniverse()
const top = monitor.universe.symbols.slice(0, 24)
console.log(JSON.stringify(top.map(item => ({ code: item.code, name: item.name })), null, 0))
monitor.stop()
