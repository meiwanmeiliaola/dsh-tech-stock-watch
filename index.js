/**
 * dsh-tech-stock-watch
 *
 * 交易时段盯住科技板块成分股，命中异动后通过 agent.followup() 主动推送到会话。
 * 插件本身只负责"接数据 + 判异动 + 推送"，调度在 src/monitor.js，判定在 src/rules.js。
 */

import { randomUUID } from 'node:crypto'
import { resolveConfig } from './src/config.js'
import { Monitor } from './src/monitor.js'

export const name = 'tech-stock-watch'

/** 依赖工具注册表与浏览器 HTTP 服务；agent/session 服务在推送时按需取，避免启动顺序问题。 */
export const inject = ['tools', 'webServer']

function quoteLine(item) {
  const code = String(item.code ?? '').replace(/^(sh|sz|bj)/, '')
  const pct = item.pct > 0 ? `+${item.pct.toFixed(1)}` : item.pct.toFixed(1)
  const ratio = item.volRatio > 0 ? `，量比 ${item.volRatio.toFixed(1)}` : ''
  return `${item.name}(${code}) ${item.price.toFixed(2)} ${pct}%${ratio}`
}

function describeStatus(status) {
  const lines = [
    `监听：${status.running ? '运行中' : '已停止'}`,
    `股票池：${status.symbols} 只（扫描 ${status.scanned} 只，${status.boards.length} 个板块）`,
    `板块：${status.boards.join('、') || '（空）'}`,
    `轮询：${status.shards} 片 × ${status.fullCycleMs / 1000} 秒一轮全池；活跃池 ${status.hotSize} 只`,
    `累计：请求 ${status.stats.requests} 次，命中 ${status.stats.alerts} 条，推送 ${status.stats.pushed} 条，错误 ${status.stats.errors} 次`,
  ]
  if (status.queue > 0) lines.push(`待推送：${status.queue} 条`)
  if (status.stats.lastError) lines.push(`最近错误：${status.stats.lastError}`)
  return lines.join('\n')
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [rawConfig]
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const log = {
    info: message => ctx.logger?.info?.(message),
    warn: message => ctx.logger?.warn?.(message),
  }

  /** 当前监听目标会话，由 tech_watch 的 start 动作记录。 */
  let targetSessionId
  let monitor

  const deliver = (text) => {
    if (targetSessionId === undefined) return false
    const agents = ctx.get('agents')
    const agent = agents?.get?.(targetSessionId)
    if (agent === undefined) return false
    try {
      // 与定时任务插件同一种投递方式：followup 会唤醒空闲会话开一轮。
      // 消息按既有约定手工构造，避免依赖 profile 里不一定解析得到的内部包。
      const message = Object.freeze({
        id: randomUUID(),
        role: 'user',
        content: Object.freeze([Object.freeze({ type: 'text', text })]),
        source: Object.freeze({ kind: 'tech-stock-watch' }),
      })
      agent.followup(message)
      const sessions = ctx.get('sessions')
      if (sessions?.flush !== undefined) {
        // 落盘失败不影响已经排进 inbox 的消息。
        void Promise.resolve(sessions.flush(agent.session)).catch(() => {})
      }
      return true
    } catch (error) {
      log.warn(`tech-stock-watch: 推送失败：${String(error)}`)
      return false
    }
  }

  monitor = new Monitor({ config, log, deliver })

  /**
   * 浏览器端拿分时和 K 线时会碰到 CORS、防盗链和限流，这里挂一个同源转发。
   * 只放行腾讯的两个数据域名，避免变成任意 URL 的出站代理。
   */
  const webserver = ctx.get('webServer')
  if (webserver?.register !== undefined) {
    ctx.effect(() => webserver.register({
      kind: 'prefix',
      path: '/tech-stock-watch/proxy',
      handler: async (req, res) => {
        const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1')
        const target = requestUrl.searchParams.get('u') ?? ''
        if (!/^https:\/\/(proxy\.finance\.qq\.com|web\.ifzq\.gtimg\.cn)\//.test(target)) {
          res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('target not allowed')
          return
        }
        try {
          const upstream = await fetch(target, {
            headers: { referer: 'https://gu.qq.com/', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
            signal: AbortSignal.timeout(12000),
          })
          const body = await upstream.text()
          res.writeHead(upstream.status, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(body)
        } catch (error) {
          res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: String(error) }))
        }
      },
    }))
  } else {
    log.warn('tech-stock-watch: webserver 不可用，浏览器端只能直连数据源')
  }

  ctx.tools.register({
    name: 'tech_watch',
    description: [
      '盯盘工具：实时监听科技板块成分股的异动。',
      '用户说“开始盯盘/盯着某只科技股/有异动告诉我”时用 start，异动会主动推送进当前会话。',
      'scan 只做一次全池扫描并返回当前最强异动，不会开启持续监听。',
      'test 发送一条测试推送，用来确认推送链路是否正常。',
      '收到以 [科技股异动] 开头的消息说明监听器刚发现异动：直接用一两句话向用户简报最关键的 1-2 条，'
        + '不要整段复述，也不要为此调用本工具。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'stop', 'status', 'scan', 'test'],
          description: 'start 开始监听；stop 停止；status 查看运行状态；scan 立即扫描一次；test 发送测试推送。',
        },
        limit: {
          type: 'integer',
          description: 'scan 返回几条，默认 10，最多 30。',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const action = args?.action
      // 任何一次调用都刷新推送目标：告警总是落到最近一次使用插件的那个会话，
      // 否则换了新会话以后，推送还会打在旧会话上。
      if (exec?.agent !== undefined) targetSessionId = exec.agent.id
      if (action === 'start') {
        const agent = exec?.agent
        if (agent === undefined) throw new Error('tech_watch start 需要在一个会话里调用，用来确定推送目标')
        targetSessionId = agent.id
        const status = await monitor.start()
        return `已开始监听，异动会推送到当前会话。\n${describeStatus(status)}`
      }
      if (action === 'stop') {
        monitor.stop()
        return '已停止监听。'
      }
      if (action === 'status') {
        return describeStatus(monitor.status())
      }
      if (action === 'scan') {
        const limit = Math.min(Math.max(Number(args?.limit ?? 10), 1), 30)
        const { count, ranked } = await monitor.scanOnce({ limit })
        if (ranked.length === 0) return `扫描完成：收到 ${count} 条报价，没有可用的异动。`
        const stamp = new Date()
        const head = `扫描完成：${count} 条报价，${stamp.getHours()}:${String(stamp.getMinutes()).padStart(2, '0')} 快照`
        return [head, ...ranked.map((item, index) => `${index + 1}. ${quoteLine(item)}`)].join('\n')
      }
      if (action === 'test') {
        const ok = deliver(`[科技股异动] 测试推送 ${new Date().toLocaleTimeString('zh-CN')}\n这条消息用于确认推送链路正常，可以忽略。`)
        return ok ? '测试推送已送达当前会话。' : '测试推送失败：还没有开始监听，或者当前会话不可达。'
      }
      throw new Error(`未知动作：${String(action)}`)
    },
  })

  // 插件卸载（禁用、热重载、进程退出）时停掉定时器。
  ctx.effect(() => () => {
    monitor.stop()
  })
}
