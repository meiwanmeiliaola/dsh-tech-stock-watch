// 离线校验分时折线的坐标：拿真实数据跑一遍同样的 min/max/yOf 逻辑。
const code = 'sh600360'
const res = await fetch(`https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${code}`)
const json = await res.json()
const rows = json.data[code].data.data
const points = []
for (const row of rows) {
  const parts = row.split(' ')
  const price = Number.parseFloat(parts[1])
  const time = parts[0]
  if (!Number.isFinite(price) || price <= 0) continue
  if (time < '0930' || time > '1500') continue
  points.push({ t: time, p: price })
}
const prevClose = Number.parseFloat(json.data[code].qt[code][4])

const width = 100
const height = 44
const prices = points.map(point => point.p)
const baseline = prevClose > 0 ? prevClose : prices[0]
const min = Math.min(...prices, baseline)
const max = Math.max(...prices, baseline)
const span = Math.max(0.01, max - min)
const xOf = index => (index / (points.length - 1)) * width
const yOf = price => height - ((price - min) / span) * (height - 6) - 3

console.log('points:', points.length, 'prevClose:', prevClose, 'min:', min, 'max:', max)
const xs = points.map((_, index) => xOf(index))
const ys = points.map(point => yOf(point.p))
console.log('x range:', Math.min(...xs).toFixed(1), '..', Math.max(...xs).toFixed(1))
console.log('y range:', Math.min(...ys).toFixed(1), '..', Math.max(...ys).toFixed(1))
console.log('baseline y:', yOf(baseline).toFixed(1))
console.log('first point:', points[0], 'last:', points[points.length - 1])
const bad = ys.filter(y => y < -0.5 || y > height + 0.5)
console.log('越界点数:', bad.length)
console.log('path 前 80 字符:', points.slice(0, 3).map((point, index) => `${index === 0 ? 'M' : 'L'}${xOf(index).toFixed(2)},${yOf(point.p).toFixed(2)}`).join(' '))
