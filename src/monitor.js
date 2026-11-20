/**
 * 监听调度器：股票池 → 分片轮询 → 异动判定 → 合并推送。
 *
 * 这是个不依赖 Cordis 的普通类，构造时注入 deliver 回调，方便单独测试和替换。
 */

import { buildUniverse, chunkSymbols } from './universe.js'
import { fetchBoardRank, fetchQuotes } from './tencent.js'
import { fetchFundFlow } from './sina.js'
import { createTracker, evaluateBoards, evaluateQuotes, evaluateStockFlow, formatDigest, compressAlerts } from './rules.js'
import { isFreshQuote, isTradingWindow } from './market.js'

export class Monitor {
  /**
   * @param {object} options
   * @param {object} options.config - 已解析配置。
   * @param {object} [options.log] - 日志器。
   * @param {(text: string) => boolean} options.deliver - 推送一条消息，返回是否送达。
   * @param {() => number} [options.now] - 时钟，测试可替换。
   */
  constructor({ config, log, deliver, now = () => Date.now() }) {
    this.config = config
    this.log = log
    this.deliver = deliver
    this.now = now
    this.tracker = createTracker()
    this.latest = new Map()
    this.queue = []
    this.lastFlushAt = 0
    this.running = false
    this.startedAt = 0
    this.busy = { shard: false, hot: false, board: false, flow: false, universe: false }
    this.shards = []
    this.cursor = 0
    this.timers = []
    this.universe = { symbols: [], boards: [], builtAt: 0 }
    this.stats = { requests: 0, alerts: 0, pushed: 0, errors: 0, lastError: '', lastTickAt: 0 }
  }

  get isRunning() {
    return this.running
  }

  /** 建池并启动全部定时器。 */
  async start() {
    if (this.running) return this.status()
    await this.refreshUniverse()
    this.running = true
    this.startedAt = this.now()
    const { config } = this
    this.every(config.shardIntervalMs, () => this.tickShards())
    this.every(config.hotIntervalMs, () => this.tickHot())
    this.every(config.boardIntervalMs, () => this.tickBoards())
    if (config.flowIntervalMs > 0) this.every(config.flowIntervalMs, () => this.tickFlow())
    this.every(config.universeRefreshMs, () => this.refreshUniverse())
    this.every(5000, () => this.flush())
    return this.status()
  }

  stop() {
    for (const timer of this.timers) clearInterval(timer)
    this.timers = []
    this.running = false
  }

  every(intervalMs, fn) {
    const timer = setInterval(() => {
      void fn()
    }, Math.max(1000, intervalMs))
    timer.unref?.()
    this.timers.push(timer)
  }

  inSession() {
    return isTradingWindow(new Date(this.now()), this.config.sessionWindows)
  }

  async refreshUniverse() {
    if (this.busy.universe) return
    this.busy.universe = true
    try {
      const universe = await buildUniverse(this.config, this.log)
      this.universe = { ...universe, builtAt: this.now() }
      this.shards = chunkSymbols(universe.symbols, this.config.shardSize)
      this.cursor = 0
    } catch (error) {
      this.stats.errors += 1
      this.stats.lastError = String(error)
      this.log?.warn?.(`tech-stock-watch: 股票池构建失败：${String(error)}`)
    } finally {
      this.busy.universe = false
    }
  }

  /** 轮询一个分片（轮转覆盖全池）。 */
  async tickShards() {
    if (!this.running || this.busy.shard || !this.inSession() || this.shards.length === 0) return
    this.busy.shard = true
    try {
      const shard = this.shards[this.cursor % this.shards.length]
      this.cursor += 1
      await this.poll(shard.map(item => item.code))
    } catch (error) {
      this.recordError(error)
    } finally {
      this.busy.shard = false
    }
  }

  /** 只刷最近最活跃的那批票，做到秒级。 */
  async tickHot() {
    if (!this.running || this.busy.hot || !this.inSession() || this.latest.size === 0) return
    this.busy.hot = true
    try {
      const hot = [...this.latest.values()]
        .map(quote => ({ code: quote.code, score: Math.abs(quote.pct) * 2 + quote.volRatio }))
        .sort((a, b) => b.score - a.score)
        .slice(0, this.config.hotSize)
        .map(item => item.code)
      if (hot.length > 0) await this.poll(hot)
    } catch (error) {
      this.recordError(error)
    } finally {
      this.busy.hot = false
    }
  }

  async tickBoards() {
    if (!this.running || this.busy.board || !this.inSession() || this.universe.boards.length === 0) return
    this.busy.board = true
    try {
      this.stats.requests += 1
      const rank = await fetchBoardRank()
      const watched = new Set(this.universe.boards.map(board => board.code))
      const boards = rank.filter(board => watched.has(board.code))
      if (boards.length === 0) return
      const { alerts, tracker } = evaluateBoards({ boards, tracker: this.tracker, thresholds: this.config.thresholds, now: this.now() })
      this.tracker = tracker
      this.enqueue(alerts)
    } catch (error) {
      this.recordError(error)
    } finally {
      this.busy.board = false
    }
  }

  async tickFlow() {
    if (!this.running || this.busy.flow || !this.inSession() || this.latest.size === 0) return
    this.busy.flow = true
    try {
      const targets = [...this.latest.values()]
        .map(quote => ({ code: quote.code, name: quote.name, score: Math.abs(quote.pct) + quote.volRatio }))
        .sort((a, b) => b.score - a.score)
        .slice(0, this.config.flowTopN)
      for (const target of targets) {
        this.stats.requests += 1
        const flow = await fetchFundFlow(target.code)
        if (flow === undefined) continue
        const { alerts, tracker } = evaluateStockFlow({
          code: target.code,
          name: target.name,
          mainNet: flow.mainNet,
          tracker: this.tracker,
          thresholds: this.config.thresholds,
          now: this.now(),
        })
        this.tracker = tracker
        this.enqueue(alerts)
      }
    } catch (error) {
      this.recordError(error)
    } finally {
      this.busy.flow = false
    }
  }

  /** 拉一批报价并判定。collect 为 true 时不经队列，直接把命中返回给调用方。 */
  async poll(codes, options = {}) {
    if (codes.length === 0) return options.collect === true ? { quotes: [], alerts: [] } : []
    this.stats.requests += 1
    const quotes = await fetchQuotes(codes)
    this.stats.lastTickAt = this.now()
    const fresh = options.ignoreFreshness === true
      ? quotes
      : quotes.filter(quote => isFreshQuote(quote.ts, this.now(), this.config.staleAfterMs))
    for (const quote of fresh) this.latest.set(quote.code, quote)
    const { alerts, tracker } = evaluateQuotes({
      quotes: fresh,
      tracker: this.tracker,
      thresholds: this.config.thresholds,
      now: this.now(),
    })
    this.tracker = tracker
    if (options.collect === true) return { quotes: fresh, alerts }
    this.enqueue(alerts)
    return fresh
  }

  enqueue(alerts) {
    if (alerts.length === 0) return
    this.stats.alerts += alerts.length
    // 预热期只建基线：开盘前启动或盘中重启时，不要把全池既有涨跌幅一次性刷出来。
    if (this.running && this.now() - this.startedAt < this.config.warmupMs) return
    const compacted = compressAlerts(alerts, {
      groupThreshold: this.config.groupThreshold,
      maxAlerts: this.config.maxAlertsPerCycle,
    })
    for (const alert of compacted) {
      const symbol = this.universe.symbols.find(item => item.code === alert.code)
      this.queue.push({ ...alert, boards: symbol?.boards })
    }
    if (this.queue.length > this.config.maxQueue) {
      this.queue.splice(0, this.queue.length - this.config.maxQueue)
    }
    if (this.queue.length >= this.config.flushBurst) this.flush(true)
  }

  /** 把队列合并成一条消息推送；节流窗口内的异动留到下一次。 */
  flush(force = false) {
    if (this.queue.length === 0) return
    const now = this.now()
    if (!force && now - this.lastFlushAt < this.config.flushIntervalMs) return
    const batch = this.queue.splice(0, this.config.maxAlertsPerMessage)
    const text = formatDigest(batch, now)
    const delivered = this.deliver(text)
    if (delivered) {
      this.stats.pushed += batch.length
      this.lastFlushAt = now
    } else {
      // 会话不在了就别攒着，丢掉并记录一次。
      this.stats.errors += 1
      this.stats.lastError = '目标会话不可达，消息已丢弃'
      this.lastFlushAt = now
    }
  }

  recordError(error) {
    this.stats.errors += 1
    this.stats.lastError = String(error)
    this.log?.warn?.(`tech-stock-watch: ${String(error)}`)
  }

  /** 全池扫一遍，返回当前最值得看的异动（只读：不改跟踪器、不排入推送队列）。 */
  async scanOnce({ limit = 10 } = {}) {
    if (this.universe.symbols.length === 0) await this.refreshUniverse()
    const savedTracker = this.tracker
    const hitsBefore = this.stats.alerts
    const found = []
    const hits = []
    for (const shard of this.shards) {
      try {
        const result = await this.poll(shard.map(item => item.code), { ignoreFreshness: true, collect: true })
        found.push(...result.quotes)
        hits.push(...result.alerts)
      } catch (error) {
        this.recordError(error)
      }
    }
    // 扫描是只读动作：判定状态还原，避免影响正式监听。
    this.tracker = savedTracker
    this.stats.alerts = hitsBefore
    const ranked = found
      .filter(quote => quote.prevClose > 0)
      .map(quote => ({
        code: quote.code,
        name: quote.name,
        price: quote.price,
        pct: ((quote.price - quote.prevClose) / quote.prevClose) * 100,
        volRatio: quote.volRatio,
        turnoverRate: quote.turnoverRate,
        boards: this.universe.symbols.find(item => item.code === quote.code)?.boards ?? [],
      }))
      .sort((a, b) => Math.abs(b.pct) * 2 + b.volRatio - (Math.abs(a.pct) * 2 + a.volRatio))
      .slice(0, limit)
    const alerts = compressAlerts(hits, {
      groupThreshold: this.config.groupThreshold,
      maxAlerts: this.config.maxAlertsPerCycle,
    })
    return { count: found.length, ranked, alerts, hitCount: hits.length }
  }

  status() {
    const builtAt = this.universe.builtAt
    return {
      running: this.running,
      symbols: this.universe.symbols.length,
      boards: this.universe.boards.map(board => board.name),
      scanned: this.universe.scanned ?? 0,
      shards: this.shards.length,
      fullCycleMs: this.shards.length * this.config.shardIntervalMs,
      hotSize: Math.min(this.config.hotSize, this.latest.size),
      stats: { ...this.stats },
      queue: this.queue.length,
      builtAt: builtAt === 0 ? undefined : new Date(builtAt).toISOString(),
    }
  }
}
