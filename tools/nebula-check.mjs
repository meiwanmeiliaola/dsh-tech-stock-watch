// 离线校验星云布局：把 layout + project 的数学跑一遍，看球是否铺开、标签是否打架。
// 只复制纯计算部分，不碰浏览器 API。

const SYMBOLS = [
  { code: 'sz300308', name: '中际旭创', group: '光模块', amountWan: 1494077, pct: 1.2 },
  { code: 'sz300502', name: '新易盛', group: '光模块', amountWan: 1474102, pct: -0.8 },
  { code: 'sz300394', name: '天孚通信', group: '光模块', amountWan: 402100, pct: 2.1 },
  { code: 'sh688498', name: '源杰科技', group: '光芯片', amountWan: 390169, pct: -1.4 },
  { code: 'sh688825', name: '长鑫科技', group: '存储', amountWan: 971708, pct: 0.7 },
  { code: 'sh603986', name: '兆易创新', group: '存储', amountWan: 402300, pct: -3.2 },
  { code: 'sh688256', name: '寒武纪', group: '算力芯片', amountWan: 947188, pct: 1.6 },
  { code: 'sh688041', name: '海光信息', group: '算力芯片', amountWan: 612000, pct: -1.1 },
  { code: 'sh688008', name: '澜起科技', group: '算力芯片', amountWan: 388000, pct: 0.4 },
  { code: 'sh688981', name: '中芯国际', group: '晶圆制造', amountWan: 882780, pct: 2.6 },
  { code: 'sh688347', name: '华虹宏力', group: '晶圆制造', amountWan: 511000, pct: -2.2 },
  { code: 'sh688012', name: '中微公司', group: '设备', amountWan: 602000, pct: 1.9 },
  { code: 'sz002371', name: '北方华创', group: '设备', amountWan: 358000, pct: -0.6 },
  { code: 'sz300604', name: '长川科技', group: '设备', amountWan: 301000, pct: 3.4 },
  { code: 'sh600584', name: '长电科技', group: '封测', amountWan: 288000, pct: -1.8 },
  { code: 'sz002156', name: '通富微电', group: '封测', amountWan: 265000, pct: -9.9 },
  { code: 'sz002463', name: '沪电股份', group: 'PCB', amountWan: 702000, pct: 0.9 },
  { code: 'sz002916', name: '深南电路', group: 'PCB', amountWan: 333000, pct: -0.4 },
  { code: 'sh600183', name: '生益科技', group: 'PCB', amountWan: 254000, pct: 1.1 },
  { code: 'sz000725', name: '京东方Ａ', group: '面板', amountWan: 402000, pct: -0.2 },
]

const GROUPS = ['光模块', '光芯片', '存储', '算力芯片', '晶圆制造', '设备', '封测', 'PCB', '面板']

function hash(seed) {
  let value = 2166136261
  for (let index = 0; index < seed.length; index += 1) {
    value ^= seed.charCodeAt(index)
    value = Math.imul(value, 16777619)
  }
  return ((value >>> 0) % 10000) / 10000
}

function layout(rows) {
  const maxAmount = Math.max(1, ...rows.map(row => row.amountWan || 0))
  const golden = Math.PI * (3 - Math.sqrt(5))
  const centers = new Map()
  GROUPS.forEach((group, index) => {
    // 团心铺在球面上，9 个团互相错开，投影后不会扎堆。
    const y = 1 - (index / (GROUPS.length - 1)) * 2
    const ring = Math.sqrt(Math.max(0, 1 - y * y))
    const theta = index * golden
    centers.set(group, {
      x: Math.cos(theta) * ring * 350,
      y: y * 195,
      z: Math.sin(theta) * ring * 350,
    })
  })
  const byGroup = new Map()
  for (const row of rows) {
    if (!byGroup.has(row.group)) byGroup.set(row.group, [])
    byGroup.get(row.group).push(row)
  }
  const output = []
  for (const [group, members] of byGroup) {
    const center = centers.get(group) ?? { x: 0, y: 0, z: 0 }
    const phase = hash(group) * Math.PI * 2
    members.forEach((row, index) => {
      // 团内按角度等分，2~3 只票会摆成三角而不是随机叠在一起。
      const angle = phase + (index / Math.max(1, members.length)) * Math.PI * 2
      const spread = members.length === 1 ? 0 : 58 + hash(`${row.code}r`) * 20
      output.push({
        ...row,
        size: 8 + Math.log10(1 + (row.amountWan / maxAmount) * 99) * 7,
        xyz: {
          x: center.x + Math.cos(angle) * spread,
          y: center.y + Math.sin(angle) * spread * 0.72,
          z: center.z + (hash(`${row.code}z`) - 0.5) * 80,
        },
      })
    })
  }
  return output
}

const view = { yaw: 0.35, pitch: -0.1, zoom: 1 }

function project(xyz, width, height) {
  const { yaw, pitch, zoom } = view
  const cosY = Math.cos(yaw)
  const sinY = Math.sin(yaw)
  const cosP = Math.cos(pitch)
  const sinP = Math.sin(pitch)
  const x1 = xyz.x * cosY - xyz.z * sinY
  const z1 = xyz.x * sinY + xyz.z * cosY
  const y1 = xyz.y * cosP - z1 * sinP
  const z2 = xyz.y * sinP + z1 * cosP
  const ortho = ((width * 0.86) / 900) * zoom
  const scale = ortho * (1 - z2 * 0.00035)
  return { x: width / 2 + x1 * ortho, y: height / 2 + y1 * ortho, z: z2, scale }
}

const width = 1200
const height = Math.round(width * 0.58)
const placed = layout(SYMBOLS)
const points = placed.map(item => ({ item, point: project(item.xyz, width, height) }))

console.log(`canvas ${width} x ${height}`)
let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
for (const { item, point } of points) {
  const radius = Math.max(2.5, item.size * point.scale)
  const labelHalf = Math.max(24, item.name.length * 6)
  minX = Math.min(minX, point.x - labelHalf)
  maxX = Math.max(maxX, point.x + labelHalf)
  minY = Math.min(minY, point.y - radius)
  maxY = Math.max(maxY, point.y + radius + 28)
  console.log(
    item.name.padEnd(5, '　'),
    `x=${point.x.toFixed(0).padStart(5)} y=${point.y.toFixed(0).padStart(4)}`,
    `r=${radius.toFixed(1).padStart(4)} z=${point.z.toFixed(0).padStart(5)}`,
  )
}
console.log(`\n内容范围 x: ${minX.toFixed(0)}..${maxX.toFixed(0)}  y: ${minY.toFixed(0)}..${maxY.toFixed(0)}`)
console.log(`覆盖画布宽度比例: ${(((maxX - minX) / width) * 100).toFixed(0)}%  高度比例: ${(((maxY - minY) / height) * 100).toFixed(0)}%`)
console.log(`越界: 左${minX < 0 ? '是' : '否'} 右${maxX > width ? '是' : '否'} 上${minY < 0 ? '是' : '否'} 下${maxY > height ? '是' : '否'}`)

// 标签重叠检测（标签框 52x30，中心在球下方）
const boxes = points.map(({ item, point }) => {
  const radius = Math.max(2.5, item.size * point.scale)
  const cy = point.y + radius + 19
  return { name: item.name, x0: point.x - 30, x1: point.x + 30, y0: cy - 15, y1: cy + 15 }
})
let overlaps = 0
for (let i = 0; i < boxes.length; i += 1) {
  for (let j = i + 1; j < boxes.length; j += 1) {
    const a = boxes[i], b = boxes[j]
    if (a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1) {
      overlaps += 1
      console.log('标签重叠:', a.name, '<->', b.name)
    }
  }
}
console.log(`标签重叠对数: ${overlaps}`)
