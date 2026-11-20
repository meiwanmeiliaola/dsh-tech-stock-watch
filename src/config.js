/**
 * 默认配置。用户在 profile 的 cordis.patch.yml 里给这个插件条目加 `config` 即可覆盖。
 */

/** 默认盯的科技板块。code 优先，name 作为代码失效时的兜底匹配。 */
export const DEFAULT_BOARDS = [
  { code: 'pt02GN2116', name: '半导体产业' },
  { code: 'pt02003891', name: '芯片概念' },
  { code: 'pt02003800', name: '人工智能' },
  { code: 'pt02003696', name: '国产软件' },
  { code: 'pt02GN2124', name: '存储器' },
  { code: 'pt02GN2190', name: '光通信' },
  { code: 'pt02GN2211', name: '共封装光模块(CPO）' },
  { code: 'pt02003640', name: '机器人概念' },
]

export const DEFAULT_CONFIG = {
  /** 盯住的板块；字符串按名称匹配，对象可写 { code, name }。 */
  boards: DEFAULT_BOARDS,

  /** 股票池上限（按当日成交额排序后截断），越大覆盖越广、轮询越慢。 */
  maxSymbols: 600,
  /** 每片多少只股票；一片一次请求。 */
  shardSize: 100,
  /** 相邻两片的间隔；全池刷新一轮 ≈ shardSize 片数 × 该间隔。 */
  shardIntervalMs: 3000,

  /** 活跃池大小与刷新间隔：只刷最近有异动的票，做到秒级。 */
  hotSize: 60,
  hotIntervalMs: 5000,

  /** 板块级（涨跌幅、涨速、主力净流入）刷新间隔。 */
  boardIntervalMs: 20000,
  /** 个股主力资金（新浪日级累计）刷新间隔，0 表示关闭。 */
  flowIntervalMs: 60000,
  flowTopN: 12,

  /** 股票池成分每天重建的间隔（盘中也会重建，用来接住新上市和调仓）。 */
  universeRefreshMs: 30 * 60 * 1000,

  /** 触发阈值。 */
  thresholds: {
    /** 涨跌幅绝对值 ≥ 该值。 */
    changePct: 3,
    /** 窗口内急拉/跳水幅度 ≥ 该值（百分比）。 */
    speedPct: 1.5,
    /** 急拉/跳水的观察窗口（秒）。 */
    speedWindowSec: 90,
    /** 量比 ≥ 该值，且涨跌幅 ≥ 1% 才算放量异动。 */
    volumeRatio: 2.5,
    /** 换手率 ≥ 该值，且涨跌幅 ≥ 2%。 */
    turnoverRate: 10,
    /** 同一只票同一类异动的冷却时间。 */
    cooldownMs: 10 * 60 * 1000,
    /** 低于该价格的票不报（过滤仙股和异常数据）。 */
    minPrice: 1,
    /** 板块级：板块涨跌幅变化 ≥ 该值（百分点）时提示。 */
    boardChangePct: 1.5,
    /** 板块级：板块主力净流入变化 ≥ 该值（万元）时提示。 */
    boardFlowWan: 5_0000,
    /** 个股级：主力净流入增量 ≥ 该值（元）时提示。 */
    stockFlowYuan: 5_000_0000,
  },

  /** 推送节流：两次推送的最小间隔，期间的异动合并。 */
  flushIntervalMs: 20000,
  /** 一条消息最多合并几条异动。 */
  maxAlertsPerMessage: 8,
  /** 队列积压超过该条数时立刻推送，不等节流窗口。 */
  flushBurst: 12,
  /** 启动后的预热时长：只建基线不推送，避免开机瞬间把全池已有涨幅刷屏。 */
  warmupMs: 30000,
  /** 单轮最多上报几条（群体异动算一条），其余丢弃。 */
  maxAlertsPerCycle: 12,
  /** 同一轮里同类异动超过该数量时合并成一条群体提示。 */
  groupThreshold: 5,
  /** 队列上限，超出时丢弃最旧的。 */
  maxQueue: 30,
  /** 交易时段判断（本地时间）。 */
  sessionWindows: [
    [9 * 60 + 10, 11 * 60 + 35],
    [12 * 60 + 55, 15 * 60 + 10],
  ],
  /** 报价时间落后超过该值就认为休市（防节假日空转刷屏）。 */
  staleAfterMs: 10 * 60 * 1000,
}

/** 浅合并用户配置，阈值单独合并一层。 */
export function resolveConfig(overrides = {}) {
  const base = { ...DEFAULT_CONFIG, ...(overrides ?? {}) }
  base.thresholds = { ...DEFAULT_CONFIG.thresholds, ...(overrides?.thresholds ?? {}) }
  if (Array.isArray(overrides?.boards) && overrides.boards.length > 0) base.boards = overrides.boards
  return base
}
