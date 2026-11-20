/**
 * 客户端模块：
 * 1. `conversation.composer.dock` 一条常驻行情带；
 * 2. `sidebar.panellist` 一个左栏入口，点开是 `main` 整页的科技股分时卡片墙，
 *    再点某张卡片放大到详情（大分时 + 成交量 + 均价线 + 日 K）。
 *
 * 浏览器可以直接请求腾讯行情、分时与日 K（实测 `Access-Control-Allow-Origin: *`），
 * 所以这里自己取数，不依赖 host 转发。行情是 GBK，分时与 K 线是 UTF-8。
 */

window.__ModuleLoader__.load({
  id: 'dsh-tech-stock-watch',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** 样本股：科技板块里流动性最好的 20 只。 */
    const SYMBOLS = [
      { code: 'sz300308', name: '中际旭创', group: '光模块' },
      { code: 'sz300502', name: '新易盛', group: '光模块' },
      { code: 'sz300394', name: '天孚通信', group: '光模块' },
      { code: 'sh688498', name: '源杰科技', group: '光芯片' },
      { code: 'sh688825', name: '长鑫科技', group: '存储' },
      { code: 'sh603986', name: '兆易创新', group: '存储' },
      { code: 'sh688256', name: '寒武纪', group: '算力芯片' },
      { code: 'sh688041', name: '海光信息', group: '算力芯片' },
      { code: 'sh688008', name: '澜起科技', group: '算力芯片' },
      { code: 'sh688981', name: '中芯国际', group: '晶圆制造' },
      { code: 'sh688347', name: '华虹宏力', group: '晶圆制造' },
      { code: 'sh688012', name: '中微公司', group: '设备' },
      { code: 'sz002371', name: '北方华创', group: '设备' },
      { code: 'sz300604', name: '长川科技', group: '设备' },
      { code: 'sh600584', name: '长电科技', group: '封测' },
      { code: 'sz002156', name: '通富微电', group: '封测' },
      { code: 'sz002463', name: '沪电股份', group: 'PCB' },
      { code: 'sz002916', name: '深南电路', group: 'PCB' },
      { code: 'sh600183', name: '生益科技', group: 'PCB' },
      { code: 'sz000725', name: '京东方Ａ', group: '面板' },
    ]

    /** 子行业配色，卡片左侧色带和详情页标题共用。 */
    const GROUP_COLORS = {
      光模块: '#4dabf7',
      光芯片: '#22b8cf',
      存储: '#9775fa',
      算力芯片: '#ff922b',
      晶圆制造: '#f06595',
      设备: '#51cf66',
      封测: '#ffd43b',
      PCB: '#74c0fc',
      面板: '#b197fc',
    }

    const QUOTE_ENDPOINT = `http://qt.gtimg.cn/q=${SYMBOLS.map(symbol => symbol.code).join(',')}`
    // 分时走 proxy 域名：web.ifzq.gtimg.cn 的 /minute/query 会返回 501 反爬页，
    // proxy.finance.qq.com 的同一份数据正常且放行 CORS。
    const MINUTE_ENDPOINT = code => `https://proxy.finance.qq.com/ifzqgtimg/appstock/app/minute/query?code=${code}`
    const KLINE_ENDPOINT = code => `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${code},day,,,40,qfq`
    const QUOTE_REFRESH_MS = 5000
    const MINUTE_REFRESH_MS = 60000
    /** 分时是一分钟一根的数据，串行拉取并留间隔，20 只并发会立刻触发限流。 */
    const MINUTE_GAP_MS = 260
    const PANEL_ID = 'tech-stock-nebula'
    const UP = '#ff5a5f'
    const DOWN = '#1fc47c'
    const FLAT = '#9aa0a8'
    const VWAP_COLOR = '#ffd43b'

    function colorOf(pct) {
      if (pct > 0) return UP
      if (pct < 0) return DOWN
      return FLAT
    }

    /**
     * 第三方数据统一走 host 的同源转发 `/tech-stock-watch/proxy`。
     * 直连会被 CORS、防盗链或限流拦住；转发不可用时再退回直连。
     */
    async function fetchJson(target) {
      try {
        const res = await fetch(`/tech-stock-watch/proxy?u=${encodeURIComponent(target)}`, { cache: 'no-store' })
        if (res.ok) return await res.json()
      } catch {
        // 落到直连。
      }
      const res = await fetch(target, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    }

    /** 解析 `v_sh600360="1~名字~600360~9.01~...";`，字段下标与 host 侧一致。 */
    function parse(text) {
      const map = new Map()
      const pattern = /v_([a-z]{2}\d{6})="([^"]*)"/g
      let match
      while ((match = pattern.exec(text)) !== null) {
        const fields = match[2].split('~')
        const price = Number.parseFloat(fields[3])
        const prevClose = Number.parseFloat(fields[4])
        if (!Number.isFinite(price) || price <= 0) continue
        map.set(match[1], {
          price,
          prevClose,
          pct: Number.isFinite(prevClose) && prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0,
          amountWan: Number.parseFloat(fields[37]) || 0,
          volRatio: Number.parseFloat(fields[49]) || 0,
          turnoverRate: Number.parseFloat(fields[38]) || 0,
          high: Number.parseFloat(fields[33]) || 0,
          low: Number.parseFloat(fields[34]) || 0,
        })
      }
      return map
    }

    function useQuotes() {
      const [state, setState] = React.useState({ rows: [], failed: false, at: 0 })

      React.useEffect(() => {
        let cancelled = false
        let timer
        const tick = async () => {
          try {
            const res = await fetch(QUOTE_ENDPOINT, { cache: 'no-store' })
            const text = new TextDecoder('gbk').decode(await res.arrayBuffer())
            const map = parse(text)
            if (cancelled) return
            setState({
              rows: SYMBOLS.map(symbol => ({
                ...symbol,
                ...(map.get(symbol.code) ?? { price: 0, prevClose: 0, pct: 0, amountWan: 0, volRatio: 0, turnoverRate: 0, high: 0, low: 0 }),
              })),
              failed: false,
              at: Date.now(),
            })
          } catch {
            if (!cancelled) setState(previous => ({ ...previous, failed: true }))
          }
          if (!cancelled) timer = setTimeout(tick, QUOTE_REFRESH_MS)
        }
        void tick()
        return () => {
          cancelled = true
          clearTimeout(timer)
        }
      }, [])

      return state
    }

    /** 分时：保留时间、价格、成交量，供大图算成交量柱和均价线。 */
    function useMinutes() {
      const [state, setState] = React.useState({ series: {}, ok: 0, fail: 0, error: '' })

      React.useEffect(() => {
        let cancelled = false
        let timer
        const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms) })
        const load = async () => {
          let ok = 0
          let fail = 0
          let lastError = ''
          for (const symbol of SYMBOLS) {
            if (cancelled) return
            try {
              const json = await fetchJson(MINUTE_ENDPOINT(symbol.code))
              const rows = json?.data?.[symbol.code]?.data?.data
              if (!Array.isArray(rows)) {
                fail += 1
                lastError = '返回结构不符'
              } else {
                const points = []
                for (const row of rows) {
                  const parts = row.split(' ')
                  const price = Number.parseFloat(parts[1])
                  const volume = Number.parseFloat(parts[2])
                  const amount = Number.parseFloat(parts[3])
                  if (!Number.isFinite(price) || price <= 0) continue
                  if (parts[0] < '0930' || parts[0] > '1500') continue
                  points.push({
                    t: parts[0],
                    p: price,
                    v: Number.isFinite(volume) ? volume : 0,
                    a: Number.isFinite(amount) ? amount : 0,
                  })
                }
                if (points.length > 1) {
                  ok += 1
                  // 拉到一只就先画一只，不用等 20 只全齐。
                  if (!cancelled) {
                    setState(previous => ({ ...previous, series: { ...previous.series, [symbol.code]: points } }))
                  }
                } else {
                  fail += 1
                  lastError = '当天没有分时点'
                }
              }
            } catch (error) {
              fail += 1
              lastError = String(error?.message ?? error)
            }
            await sleep(MINUTE_GAP_MS)
          }
          if (!cancelled) {
            setState(previous => ({ ...previous, ok, fail, error: lastError }))
            timer = setTimeout(load, MINUTE_REFRESH_MS)
          }
        }
        void load()
        return () => {
          cancelled = true
          clearTimeout(timer)
        }
      }, [])

      return state
    }

    /** 卡片分时线：渐变填充 + 底层发光 + 主线，宽度靠 viewBox 自适应。 */
    function Sparkline({ points, prevClose, color, id }) {
      if (!Array.isArray(points) || points.length < 2) {
        return h('div', { style: { height: 44, display: 'flex', alignItems: 'center', fontSize: 10, opacity: 0.4 } }, '无分时数据')
      }
      const width = 100
      const height = 44
      const prices = points.map(point => point.p)
      const baseline = prevClose > 0 ? prevClose : prices[0]
      const min = Math.min(...prices, baseline)
      const max = Math.max(...prices, baseline)
      const span = Math.max(0.01, max - min)
      const xOf = index => (index / (points.length - 1)) * width
      const yOf = price => height - ((price - min) / span) * (height - 6) - 3
      const line = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${xOf(index).toFixed(2)},${yOf(point.p).toFixed(2)}`).join(' ')
      const area = `${line} L${width},${height} L0,${height} Z`
      const baseY = yOf(baseline)

      return h('svg', {
        viewBox: `0 0 ${width} ${height}`,
        preserveAspectRatio: 'none',
        style: { width: '100%', height: 44, display: 'block' },
        role: 'img',
        'aria-label': '分时走势',
      },
      h('defs', null,
        h('linearGradient', { id: `${id}-fill`, x1: 0, y1: 0, x2: 0, y2: 1 },
          h('stop', { offset: '0%', stopColor: color, stopOpacity: 0.4 }),
          h('stop', { offset: '100%', stopColor: color, stopOpacity: 0 }))),
      h('line', {
        x1: 0, y1: baseY, x2: width, y2: baseY,
        stroke: 'currentColor', strokeOpacity: 0.26, strokeWidth: 0.8,
        strokeDasharray: '3 3', vectorEffect: 'non-scaling-stroke',
      }),
      h('path', { d: area, fill: `url(#${id}-fill)` }),
      // 发光层：比主线粗四倍、低透明度，描边在暗色背景上更抓眼。
      h('path', {
        d: line, fill: 'none', stroke: color, strokeWidth: 4, strokeOpacity: 0.2,
        strokeLinejoin: 'round', strokeLinecap: 'round', vectorEffect: 'non-scaling-stroke',
      }),
      h('path', {
        d: line, fill: 'none', stroke: color, strokeWidth: 1.6,
        strokeLinejoin: 'round', strokeLinecap: 'round', vectorEffect: 'non-scaling-stroke',
      }))
    }

    /** 日 K：40 根蜡烛，涨红跌绿（A 股习惯，收盘高于开盘为红）。 */
    function CandleChart({ bars }) {
      if (!Array.isArray(bars) || bars.length < 2) {
        return h('div', { style: { fontSize: 10, opacity: 0.4, padding: '8px 0' } }, 'K 线加载中…')
      }
      const width = 100
      const height = 40
      const highs = bars.map(bar => bar.high)
      const lows = bars.map(bar => bar.low)
      const min = Math.min(...lows)
      const max = Math.max(...highs)
      const span = Math.max(0.01, max - min)
      const step = width / bars.length
      const bodyWidth = Math.max(0.5, step * 0.58)
      const yOf = price => height - ((price - min) / span) * (height - 4) - 2

      return h('svg', {
        viewBox: `0 0 ${width} ${height}`,
        preserveAspectRatio: 'none',
        style: { width: '100%', height: 92, display: 'block' },
        role: 'img',
        'aria-label': '日 K 线',
      }, bars.map((bar, index) => {
        const x = index * step + step / 2
        const rising = bar.close >= bar.open
        const color = rising ? UP : DOWN
        const top = yOf(Math.max(bar.open, bar.close))
        const bottom = yOf(Math.min(bar.open, bar.close))
        return h('g', { key: bar.date },
          h('line', {
            x1: x, y1: yOf(bar.high), x2: x, y2: yOf(bar.low),
            stroke: color, strokeWidth: 0.35, vectorEffect: 'non-scaling-stroke',
          }),
          h('rect', {
            x: x - bodyWidth / 2,
            y: top,
            width: bodyWidth,
            height: Math.max(0.4, bottom - top),
            fill: color,
          }))
      }))
    }

    /** 把 "0930" 变成 "09:30"。 */
    function formatMinute(stamp) {
      return typeof stamp === 'string' && stamp.length >= 4
        ? `${stamp.slice(0, 2)}:${stamp.slice(2, 4)}`
        : String(stamp ?? '')
    }

    /**
     * 大分时：价格线 + 均价线 + 成交量柱。
     * 鼠标移上去按横坐标找最近的一分钟，画十字线并给出该分钟的价格、涨跌幅和均价。
     */
    function DetailChart({ row, points, color }) {
      const svgRef = React.useRef(null)
      const [hoverIndex, setHoverIndex] = React.useState(null)

      const width = 100
      const priceTop = 2
      const priceHeight = 64
      const volHeight = 24
      const prices = points.map(point => point.p)
      const baseline = row.prevClose > 0 ? row.prevClose : prices[0]
      const min = Math.min(...prices, baseline)
      const max = Math.max(...prices, baseline)
      const span = Math.max(0.01, max - min)
      const xOf = index => (index / (points.length - 1)) * width
      const yOf = price => priceTop + priceHeight - ((price - min) / span) * (priceHeight - 4)

      let cumulativeAmount = 0
      let cumulativeVolume = 0
      const vwap = points.map(point => {
        cumulativeAmount += point.a
        cumulativeVolume += point.v
        const value = cumulativeVolume > 0 ? cumulativeAmount / (cumulativeVolume * 100) : point.p
        return Number.isFinite(value) && value > 0 ? value : point.p
      })
      const line = points
        .map((point, index) => `${index === 0 ? 'M' : 'L'}${xOf(index).toFixed(2)},${yOf(point.p).toFixed(2)}`)
        .join(' ')
      const area = `${line} L${width},${priceTop + priceHeight} L0,${priceTop + priceHeight} Z`
      const vwapLine = vwap
        .map((price, index) => `${index === 0 ? 'M' : 'L'}${xOf(index).toFixed(2)},${yOf(price).toFixed(2)}`)
        .join(' ')
      const maxVolume = Math.max(1, ...points.map(point => point.v))
      const barWidth = Math.max(0.12, (width / points.length) * 0.62)

      const onMove = event => {
        const rect = svgRef.current?.getBoundingClientRect()
        if (rect === undefined || rect.width === 0) return
        const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
        setHoverIndex(Math.round(ratio * (points.length - 1)))
      }

      const index = hoverIndex === null ? null : Math.min(Math.max(hoverIndex, 0), points.length - 1)
      const point = index === null ? null : points[index]
      const pct = point === null || row.prevClose <= 0 ? 0 : ((point.p - row.prevClose) / row.prevClose) * 100
      const tipLeft = index === null ? 50 : Math.min(84, Math.max(16, (index / (points.length - 1)) * 100))

      return h('div', { style: { position: 'relative' } },

      h('svg', {
        ref: svgRef,
        viewBox: `0 0 ${width} 100`,
        preserveAspectRatio: 'none',
        style: { width: '100%', height: 260, display: 'block', cursor: 'crosshair' },
        onPointerMove: onMove,
        onPointerLeave: () => setHoverIndex(null),
        role: 'img',
        'aria-label': '当日分时与成交量',
      },
      h('defs', null,
        h('linearGradient', { id: `detail-fill-${row.code}`, x1: 0, y1: 0, x2: 0, y2: 1 },
          h('stop', { offset: '0%', stopColor: color, stopOpacity: 0.34 }),
          h('stop', { offset: '100%', stopColor: color, stopOpacity: 0 }))),
      h('line', {
        x1: 0, y1: yOf(baseline), x2: width, y2: yOf(baseline),
        stroke: 'currentColor', strokeOpacity: 0.24, strokeWidth: 0.7,
        strokeDasharray: '2 2', vectorEffect: 'non-scaling-stroke',
      }),
      h('path', { d: area, fill: `url(#detail-fill-${row.code})` }),
      h('path', {
        d: line, fill: 'none', stroke: color, strokeWidth: 3.4, strokeOpacity: 0.16,
        strokeLinejoin: 'round', vectorEffect: 'non-scaling-stroke',
      }),
      h('path', {
        d: line, fill: 'none', stroke: color, strokeWidth: 1.3,
        strokeLinejoin: 'round', vectorEffect: 'non-scaling-stroke',
      }),
      h('path', {
        d: vwapLine, fill: 'none', stroke: VWAP_COLOR, strokeWidth: 1,
        strokeOpacity: 0.9, strokeLinejoin: 'round', vectorEffect: 'non-scaling-stroke',
      }),
      points.map((item, order) => h('rect', {
        key: item.t,
        x: xOf(order) - barWidth / 2,
        y: 100 - (item.v / maxVolume) * volHeight,
        width: barWidth,
        height: Math.max(0.2, (item.v / maxVolume) * volHeight),
        fill: color,
        opacity: 0.55,
      })),
      // 十字线：竖线对齐到最近的一分钟，横线对齐到该分钟价格。
      index === null ? null : h('line', {
        x1: xOf(index), y1: priceTop, x2: xOf(index), y2: 100,
        stroke: 'rgba(255,255,255,0.5)', strokeWidth: 1,
        vectorEffect: 'non-scaling-stroke',
      }),
      index === null ? null : h('line', {
        x1: 0, y1: yOf(point.p), x2: width, y2: yOf(point.p),
        stroke: 'rgba(255,255,255,0.32)', strokeWidth: 1, strokeDasharray: '3 3',
        vectorEffect: 'non-scaling-stroke',
      })),

      // 圆点和提示框放在 SVG 外面，避免 preserveAspectRatio="none" 把圆拉成椭圆。
      index === null ? null : h('div', {
        style: {
          position: 'absolute', left: `${(index / (points.length - 1)) * 100}%`,
          top: `${yOf(point.p)}%`, width: 9, height: 9, borderRadius: '50%',
          background: color, border: '1.5px solid #ffffff',
          transform: 'translate(-50%, -50%)', pointerEvents: 'none',
          boxShadow: '0 0 8px rgba(0,0,0,0.6)',
        },
      }),

      index === null ? null : h('div', {
        style: {
          position: 'absolute', top: 4, left: `${tipLeft}%`, transform: 'translateX(-50%)',
          pointerEvents: 'none', padding: '5px 9px', borderRadius: 8,
          background: 'rgba(10,12,16,0.93)', border: '1px solid rgba(255,255,255,0.16)',
          fontSize: 11.5, lineHeight: 1.55, whiteSpace: 'nowrap', color: '#e6e9ee',
          boxShadow: '0 6px 20px rgba(0,0,0,0.45)',
        },
      },
      h('div', { style: { fontVariantNumeric: 'tabular-nums' } },
        `${formatMinute(point.t)}  ${point.p.toFixed(2)}  ${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`),
      h('div', { style: { opacity: 0.75, fontVariantNumeric: 'tabular-nums' } },
        `均价 ${vwap[index].toFixed(2)} · 量 ${(point.v / 10000).toFixed(2)} 万手`)))
    }

    /** 详情：大分时（价格 + 均价 + 成交量）加日 K。 */
    function DetailModal({ row, points: initialPoints, onClose }) {
      const [bars, setBars] = React.useState(null)
      const [failed, setFailed] = React.useState(false)
      const [points, setPoints] = React.useState(initialPoints)
      const [minuteNote, setMinuteNote] = React.useState('')

      React.useEffect(() => {
        setPoints(initialPoints)
        if (Array.isArray(initialPoints) && initialPoints.length > 1) return undefined
        // 预加载没拿到时，点开再单独拉一次这只，避免整页批量失败就彻底没有分时。
        let cancelled = false
        setMinuteNote('正在获取分时…')
        fetchJson(MINUTE_ENDPOINT(row.code))
          .then(json => {
            if (cancelled) return
            const rows = json?.data?.[row.code]?.data?.data
            if (!Array.isArray(rows)) {
              setMinuteNote('分时接口没有返回数据')
              return
            }
            const parsed = []
            for (const item of rows) {
              const parts = item.split(' ')
              const price = Number.parseFloat(parts[1])
              if (!Number.isFinite(price) || price <= 0) continue
              if (parts[0] < '0930' || parts[0] > '1500') continue
              parsed.push({
                t: parts[0],
                p: price,
                v: Number.parseFloat(parts[2]) || 0,
                a: Number.parseFloat(parts[3]) || 0,
              })
            }
            setPoints(parsed)
            setMinuteNote(parsed.length > 1 ? '' : '当天没有分时点')
          })
          .catch(error => {
            if (!cancelled) setMinuteNote(`分时获取失败：${String(error?.message ?? error)}`)
          })
        return () => { cancelled = true }
      }, [row.code, initialPoints])

      React.useEffect(() => {
        let cancelled = false
        fetchJson(KLINE_ENDPOINT(row.code))
          .then(json => {
            if (cancelled) return
            const list = json?.data?.[row.code]?.qfqday
            if (!Array.isArray(list)) {
              setFailed(true)
              return
            }
            setBars(list.map(item => ({
              date: item[0],
              open: Number.parseFloat(item[1]),
              close: Number.parseFloat(item[2]),
              high: Number.parseFloat(item[3]),
              low: Number.parseFloat(item[4]),
              volume: Number.parseFloat(item[5]),
            })).filter(bar => Number.isFinite(bar.close)))
          })
          .catch(() => { if (!cancelled) setFailed(true) })
        return () => { cancelled = true }
      }, [row.code])

      const color = colorOf(row.pct)
      const change = row.price > 0 && row.prevClose > 0 ? row.price - row.prevClose : 0
      const sign = change > 0 ? '+' : ''

      const chart = Array.isArray(points) && points.length > 1
        ? h(DetailChart, { row, points, color })
        : null

      return h('div', {
        onClick: onClose,
        style: {
          position: 'fixed', inset: 0, zIndex: 1200,
          background: 'rgba(6,8,12,0.62)', backdropFilter: 'blur(2px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
          boxSizing: 'border-box',
        },
      },
      h('div', {
        onClick: event => event.stopPropagation(),
        style: {
          width: 'min(880px, 100%)', maxHeight: '88vh', overflowY: 'auto',
          borderRadius: 14, padding: '18px 20px 20px',
          // 不跟随主题变量：深浅主题切换时弹窗文字曾因 inherit 变成同色看不清。
          background: '#15181e', color: '#e6e9ee',
          border: '1px solid rgba(255,255,255,0.14)',
          boxShadow: '0 24px 70px rgba(0,0,0,0.55)',
          boxSizing: 'border-box',
        },
      },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 4 } },
      h('span', { style: { fontSize: 18, fontWeight: 700, minWidth: 0, color: '#f4f6fa' } }, row.name),
      h('span', {
        style: { fontSize: 11, padding: '1px 7px', borderRadius: 999, color: GROUP_COLORS[row.group] ?? '#9aa0a8',
          border: `1px solid ${GROUP_COLORS[row.group] ?? 'rgba(255,255,255,0.3)'}` },
      }, row.group),
      h('span', { style: { fontSize: 22, fontWeight: 800, color, fontVariantNumeric: 'tabular-nums' } },
        `${row.pct > 0 ? '+' : ''}${row.pct.toFixed(2)}%`),
      h('span', { style: { fontSize: 15, fontWeight: 700, color, fontVariantNumeric: 'tabular-nums' } },
        `${sign}${Math.abs(change).toFixed(2)} 元`),
      h('span', { style: { fontSize: 13, color: 'rgba(230,233,238,0.75)', fontVariantNumeric: 'tabular-nums' } },
        `现价 ${row.price > 0 ? row.price.toFixed(2) : '—'} · 昨收 ${row.prevClose > 0 ? row.prevClose.toFixed(2) : '—'}`),
      h('span', { style: { flex: '1 1 auto' } }),
      h('button', {
        onClick: onClose,
        style: {
          fontSize: 12, padding: '3px 10px', borderRadius: 8, cursor: 'pointer',
          border: '1px solid rgba(127,127,127,0.3)', background: 'transparent', color: 'inherit',
        },
      }, '关闭')),

      h('div', { style: { fontSize: 11, opacity: 0.62, marginBottom: 8 } },
        `量比 ${row.volRatio.toFixed(1)} · 换手 ${row.turnoverRate.toFixed(1)}% · 成交 ${(row.amountWan / 10000).toFixed(1)} 亿`
        + ` · 最高 ${row.high.toFixed(2)} · 最低 ${row.low.toFixed(2)}`),

      chart ?? h('div', { style: { fontSize: 12, opacity: 0.6, padding: '30px 0' } },
        `暂无分时数据${minuteNote === '' ? '' : `（${minuteNote}）`}`),

      chart === null ? null : h('div', {
        style: { display: 'flex', justifyContent: 'space-between', fontSize: 9.5, opacity: 0.45, marginTop: -2 },
      },
      h('span', null, '09:30'),
      h('span', null, '11:30 / 13:00'),
      h('span', null, '15:00')),

      h('div', { style: { display: 'flex', alignItems: 'center', gap: 14, margin: '14px 0 4px', fontSize: 11, opacity: 0.62 } },
      h('span', { style: { width: 10, height: 2, background: VWAP_COLOR, display: 'inline-block' } }),
      h('span', null, '均价线'),
      h('span', null, '·'),
      h('span', { style: { width: 10, height: 2, background: color, display: 'inline-block' } }),
      h('span', null, '价格线'),
      h('span', null, '·'),
      h('span', null, '下方柱状为每分钟成交量')),

      h('div', { style: { fontSize: 12, fontWeight: 600, margin: '12px 0 6px', opacity: 0.9 } }, '近 40 日日 K（前复权）'),
      failed
        ? h('div', { style: { fontSize: 11, opacity: 0.5 } }, 'K 线暂不可用')
        : h(CandleChart, { bars }),

      Array.isArray(bars) && bars.length > 1 ? h('div', {
        style: { display: 'flex', justifyContent: 'space-between', fontSize: 9.5, opacity: 0.45, marginTop: 2 },
      },
      h('span', null, bars[0].date),
      h('span', null, bars[Math.floor(bars.length / 2)].date),
      h('span', null, bars[bars.length - 1].date)) : null)
      )
    }

    /** 输入框下方的一行摘要。 */
    function Ticker() {
      const { rows, failed } = useQuotes()
      if (rows.length === 0) {
        return h('div', { style: { fontSize: 11, opacity: 0.5, padding: '2px 2px' } },
          failed ? '科技股行情暂不可用' : '科技股行情加载中…')
      }
      return h('div', {
        style: {
          display: 'flex', gap: 14, overflowX: 'auto', whiteSpace: 'nowrap',
          fontSize: 11, lineHeight: 1.6, padding: '2px 0', scrollbarWidth: 'thin',
        },
      }, rows.map(row => h('span', {
        key: row.code,
        title: `${row.name} ${row.price.toFixed(2)}  量比 ${row.volRatio.toFixed(1)}`,
        style: { display: 'inline-flex', gap: 4, alignItems: 'baseline' },
      },
      h('span', { style: { opacity: 0.7 } }, row.name),
      h('span', {
        style: { color: colorOf(row.pct), fontVariantNumeric: 'tabular-nums' },
      }, `${row.pct > 0 ? '+' : ''}${row.pct.toFixed(2)}%`))))
    }

    /** 左栏入口图标。 */
    function TechIcon({ size = 20, active = false }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 20 20', 'aria-hidden': true,
        style: { display: 'block', opacity: active ? 1 : 0.75 },
      },
      h('path', {
        d: 'M2 14 L6 9 L9.5 12 L14 5.5 L18 8',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.7,
        strokeLinecap: 'round', strokeLinejoin: 'round',
      }),
      h('circle', { cx: 14, cy: 5.5, r: 1.6, fill: 'currentColor' }))
    }

    const CARD_STYLE = `
      .tsw-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(152px, 1fr)); gap: 10px; width: 100%; }
      .tsw-card { position: relative; min-width: 0; border-radius: 10px; padding: 9px 11px 8px 12px;
        border: 1px solid rgba(127,127,127,0.16); background: rgba(127,127,127,0.045);
        cursor: pointer; transition: border-color 140ms ease, transform 140ms ease, background 140ms ease; }
      .tsw-card:hover { border-color: rgba(127,127,127,0.4); transform: translateY(-1px); background: rgba(127,127,127,0.085); }
      .tsw-card::after { content: ''; position: absolute; inset: 0; border-radius: 10px; pointer-events: none;
        background: linear-gradient(160deg, rgba(255,255,255,0.05), transparent 55%); }
      .tsw-name, .tsw-sub { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .tsw-pct { flex: 0 0 auto; font-variant-numeric: tabular-nums; }
      @media (max-width: 520px) { .tsw-grid { grid-template-columns: repeat(auto-fill, minmax(134px, 1fr)); gap: 8px; } }
    `

    /** 整页：概览 + 卡片墙 + 详情。 */
    function WatchPage() {
      const quotes = useQuotes()
      const minuteState = useMinutes()
      const minutes = minuteState.series
      const [openCode, setOpenCode] = React.useState(null)
      const rows = quotes.rows
      const ups = rows.filter(row => row.pct > 0).length
      const downs = rows.filter(row => row.pct < 0).length
      const average = rows.length === 0 ? 0 : rows.reduce((sum, row) => sum + row.pct, 0) / rows.length
      const totalAmount = rows.reduce((sum, row) => sum + (row.amountWan || 0), 0)
      const stamp = quotes.at === 0 ? '—' : new Date(quotes.at).toLocaleTimeString('zh-CN', { hour12: false })
      const openRow = openCode === null ? null : rows.find(row => row.code === openCode) ?? null

      return h('div', {
        style: { padding: '18px 22px 26px', color: 'inherit', width: '100%', boxSizing: 'border-box' },
      },
      h('style', null, CARD_STYLE),

      h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 14, flexWrap: 'wrap', marginBottom: 4 } },
      h('div', { style: { fontSize: 15, fontWeight: 600 } }, '科技股走势'),
      h('div', { style: { fontSize: 12, opacity: 0.66, minWidth: 0 } },
        `${rows.length} 只 · 涨 ${ups} 跌 ${downs} · 均值 ${average > 0 ? '+' : ''}${average.toFixed(2)}% · 成交 ${(totalAmount / 10000).toFixed(0)} 亿 · ${stamp}`),
      quotes.failed ? h('div', { style: { fontSize: 12, color: UP } }, '行情暂不可用') : null),

      h('div', { style: { fontSize: 11, opacity: 0.5, marginBottom: 12 } },
        '卡片是当日分时，虚线为昨收；点卡片看大图、均价线和日 K。行情 5 秒刷新，分时 60 秒刷新。'
        + ` 分时已取 ${minuteState.ok}/${SYMBOLS.length} 只`
        + (minuteState.fail > 0 ? `，${minuteState.fail} 只失败（${minuteState.error}）` : '')),

      h('div', { className: 'tsw-grid' }, rows.map(row => {
        const color = colorOf(row.pct)
        const groupColor = GROUP_COLORS[row.group] ?? FLAT
        return h('div', {
          key: row.code,
          className: 'tsw-card',
          onClick: () => setOpenCode(row.code),
          style: { borderLeft: `3px solid ${groupColor}` },
        },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 } },
        h('span', {
          className: 'tsw-name',
          title: `${row.name}（${row.group}）`,
          style: { fontSize: 12.5, fontWeight: 600, flex: '1 1 auto' },
        }, row.name),
        h('span', { className: 'tsw-pct', style: { fontSize: 12.5, fontWeight: 700, color } },
          `${row.pct > 0 ? '+' : ''}${row.pct.toFixed(2)}%`)),

        h(Sparkline, {
          points: minutes[row.code],
          prevClose: row.prevClose,
          color,
          id: `tsw-${row.code}`,
        }),

        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0, fontSize: 10.5, opacity: 0.72 } },
        h('span', { className: 'tsw-sub', style: { flex: '0 0 auto' } }, row.price > 0 ? row.price.toFixed(2) : '—'),
        h('span', { className: 'tsw-sub', style: { flex: '1 1 auto', textAlign: 'right' } },
          row.volRatio > 0 ? `量比 ${row.volRatio.toFixed(1)}` : '')))
      })),

      openRow === null ? null : h(DetailModal, {
        row: openRow,
        points: minutes[openRow.code],
        onClose: () => setOpenCode(null),
      })
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'tech-stock-ticker',
          order: 5,
        }, Ticker))

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 4,
          label: () => '科技股',
        }, TechIcon))

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
        }, WatchPage))
      },
    }
  },
})
