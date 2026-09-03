import type { Agent as HttpAgent } from 'node:http'

import { SocksProxyAgent } from 'socks-proxy-agent'
import createHttpsProxyAgent from 'https-proxy-agent'

import { telegramProxyStore, type TelegramProxyRecord } from '../services/telegramProxyStore'
import {
  findHysteriaBinary,
  findXrayBinary,
  getMainTunnelEngine,
  isMainTunnelRunning,
  startMainVlessTunnel,
  stopMainVlessTunnel,
} from '../services/telegramProxyTunnel'
import { logger } from './logger'
import { parseTunnelUri } from './vlessUri'

export interface GramJsSocksProxy {
  ip: string
  port: number
  socksType: 5
  username?: string
  password?: string
}

let httpAgent: HttpAgent | undefined
let httpsAgent: HttpAgent | undefined
let pollHttpAgent: HttpAgent | undefined
let pollHttpsAgent: HttpAgent | undefined
let changeHandler: (() => void) | null = null

export function setTelegramProxyChangeHandler(handler: () => void): void {
  changeHandler = handler
}

export function getTelegramProxyAgents(): { httpAgent: HttpAgent; httpsAgent: HttpAgent } | null {
  if (!httpAgent || !httpsAgent) {
    return null
  }
  return { httpAgent, httpsAgent }
}

/** Отдельные агенты только для getUpdates — исходящие sendMessage не делят с ними сокет. */
export function getTelegramPollProxyAgents(): { httpAgent: HttpAgent; httpsAgent: HttpAgent } | null {
  if (!pollHttpAgent || !pollHttpsAgent) {
    return getTelegramProxyAgents()
  }
  return { httpAgent: pollHttpAgent, httpsAgent: pollHttpsAgent }
}

function socksAgentFor(record: TelegramProxyRecord, host: string, port: number): HttpAgent {
  const auth =
    record.username || record.password
      ? `${encodeURIComponent(record.username)}:${encodeURIComponent(record.password)}@`
      : ''
  return new SocksProxyAgent(`socks5h://${auth}${host}:${port}`, {
    timeout: 45_000,
  }) as unknown as HttpAgent
}

function httpProxyAgentFor(record: TelegramProxyRecord): HttpAgent {
  const auth =
    record.username || record.password
      ? `${encodeURIComponent(record.username)}:${encodeURIComponent(record.password)}@`
      : ''
  return createHttpsProxyAgent(`http://${auth}${record.host}:${record.port}`) as unknown as HttpAgent
}

function notifyChanged(): void {
  changeHandler?.()
}

export function describeActiveProxyRuntime(): {
  mode: 'direct' | 'vless' | 'hysteria2' | 'socks5' | 'http'
  tunnel_running: boolean
  tunnel_engine: 'xray' | 'hysteria' | null
  xray_available: boolean
  hysteria_available: boolean
  xray_path: string | null
  hysteria_path: string | null
  applied: boolean
  warning: string | null
} {
  const xrayPath = findXrayBinary()
  const hysteriaPath = findHysteriaBinary()
  const state = telegramProxyStore.getState()
  const active = telegramProxyStore.getActive()
  if (!state.enabled || !active) {
    return {
      mode: 'direct',
      tunnel_running: isMainTunnelRunning(),
      tunnel_engine: getMainTunnelEngine(),
      xray_available: xrayPath !== null,
      hysteria_available: hysteriaPath !== null,
      xray_path: xrayPath,
      hysteria_path: hysteriaPath,
      applied: false,
      warning: null,
    }
  }
  const applied = getTelegramProxyAgents() !== null
  let warning: string | null = null
  if (active.kind === 'vless' && !applied) {
    warning = xrayPath
      ? 'Не удалось поднять VLESS-туннель. Проверьте ключ или логи xray.'
      : 'Для ключей VLESS нужен xray-core на сервере (переменная XRAY_BIN) либо SOCKS5 с панели.'
  }
  if (active.kind === 'hysteria2' && !applied) {
    warning = hysteriaPath
      ? 'Не удалось поднять туннель Hysteria2. Проверьте ключ или логи hysteria.'
      : 'Клиент Hysteria2 не найден. При проверке бот скачает его в bin/hysteria (GitHub + зеркала). Можно положить бинарник в bin/ или задать HYSTERIA_BIN.'
  }
  if (active.kind === 'http' && applied) {
    warning = 'HTTP-прокси работает для Bot API. MTProto (user-сессия) идёт напрямую — лучше SOCKS5, VLESS или Hysteria2.'
  }
  return {
    mode: active.kind,
    tunnel_running: isMainTunnelRunning(),
    tunnel_engine: getMainTunnelEngine(),
    xray_available: xrayPath !== null,
    hysteria_available: hysteriaPath !== null,
    xray_path: xrayPath,
    hysteria_path: hysteriaPath,
    applied,
    warning,
  }
}

export async function applyTelegramProxyRuntime(): Promise<void> {
  httpAgent = undefined
  httpsAgent = undefined
  pollHttpAgent = undefined
  pollHttpsAgent = undefined
  await stopMainVlessTunnel()

  const state = telegramProxyStore.getState()
  const active = telegramProxyStore.getActive()
  if (!state.enabled || !active) {
    logger.info('[telegramProxy] Telegram goes direct (proxy off)')
    notifyChanged()
    return
  }

  try {
    if (active.kind === 'vless' || active.kind === 'hysteria2') {
      const parsed = parseTunnelUri(active.uri)
      await startMainVlessTunnel(parsed, state.localSocksPort)
      const agent = socksAgentFor(active, '127.0.0.1', state.localSocksPort)
      const pollAgent = socksAgentFor(active, '127.0.0.1', state.localSocksPort)
      httpAgent = agent
      httpsAgent = agent
      pollHttpAgent = pollAgent
      pollHttpsAgent = pollAgent
    } else if (active.kind === 'socks5') {
      const agent = socksAgentFor(active, active.host, active.port)
      const pollAgent = socksAgentFor(active, active.host, active.port)
      httpAgent = agent
      httpsAgent = agent
      pollHttpAgent = pollAgent
      pollHttpsAgent = pollAgent
    } else {
      const agent = httpProxyAgentFor(active)
      const pollAgent = httpProxyAgentFor(active)
      httpAgent = agent
      httpsAgent = agent
      pollHttpAgent = pollAgent
      pollHttpsAgent = pollAgent
    }
    logger.info('[telegramProxy] applied', {
      kind: active.kind,
      host: active.host,
      port: active.port,
    })
  } catch (err: unknown) {
    httpAgent = undefined
    httpsAgent = undefined
    pollHttpAgent = undefined
    pollHttpsAgent = undefined
    logger.error('[telegramProxy] failed to apply, falling back to direct', err)
  }
  notifyChanged()
}

export function createSocksAgent(host: string, port: number, username = '', password = ''): HttpAgent {
  const auth = username || password ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : ''
  return new SocksProxyAgent(`socks5h://${auth}${host}:${port}`, {
    timeout: 45_000,
  }) as unknown as HttpAgent
}

export function createHttpProxyAgent(host: string, port: number, username = '', password = ''): HttpAgent {
  const auth = username || password ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : ''
  return createHttpsProxyAgent(`http://${auth}${host}:${port}`) as unknown as HttpAgent
}

export function getGramJsClientOptions(): {
  connectionRetries: number
  proxy?: GramJsSocksProxy
} {
  const base = { connectionRetries: 5 }
  const state = telegramProxyStore.getState()
  const active = telegramProxyStore.getActive()
  if (!state.enabled || !active || !getTelegramProxyAgents()) {
    return base
  }
  if (active.kind === 'vless' || active.kind === 'hysteria2') {
    return {
      ...base,
      proxy: {
        ip: '127.0.0.1',
        port: state.localSocksPort,
        socksType: 5,
      },
    }
  }
  if (active.kind === 'socks5') {
    return {
      ...base,
      proxy: {
        ip: active.host,
        port: active.port,
        socksType: 5,
        username: active.username || undefined,
        password: active.password || undefined,
      },
    }
  }
  return base
}
