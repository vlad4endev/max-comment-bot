import type { Agent as HttpAgent } from 'node:http'
import net from 'node:net'

import axios from 'axios'

import { resolveTelegramBotToken } from './resolveTelegramBotToken'
import {
  telegramProxyStore,
  type ProxyProbeSnapshot,
  type ProxyQuality,
  type TelegramProxyRecord,
} from './telegramProxyStore'
import { isMainTunnelRunning, withTempVlessSocks } from './telegramProxyTunnel'
import {
  createHttpProxyAgent,
  createSocksAgent,
  getTelegramProxyAgents,
} from '../utils/telegramProxyRuntime'
import { parseVlessUri } from '../utils/vlessUri'

const GOOD_MS = 900
const PROBE_TIMEOUT_MS = 12_000
const TCP_TIMEOUT_MS = 5_000

let probeLock: Promise<void> = Promise.resolve()

function withProbeLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = probeLock.then(fn, fn)
  probeLock = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

function qualityFrom(telegramOk: boolean, latencyMs: number | null): ProxyQuality {
  if (!telegramOk || latencyMs == null) {
    return 'down'
  }
  return latencyMs <= GOOD_MS ? 'good' : 'poor'
}

function tcpPing(host: string, port: number, timeoutMs: number): Promise<{ ok: boolean; ms: number }> {
  return new Promise((resolve) => {
    const started = Date.now()
    const socket = net.connect({ host, port })
    const timer = setTimeout(() => {
      socket.destroy()
      resolve({ ok: false, ms: Date.now() - started })
    }, timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      const ms = Date.now() - started
      socket.end()
      resolve({ ok: true, ms })
    })
    socket.once('error', () => {
      clearTimeout(timer)
      socket.destroy()
      resolve({ ok: false, ms: Date.now() - started })
    })
  })
}

function extractError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    if (err.code === 'ECONNABORTED') {
      return 'Таймаут'
    }
    if (err.code) {
      return err.code
    }
    if (err.response?.status) {
      return `HTTP ${err.response.status}`
    }
    return err.message
  }
  return err instanceof Error ? err.message : String(err ?? 'ошибка')
}

async function probeTelegramApi(agent: HttpAgent | null, timeoutMs: number): Promise<{
  ok: boolean
  ms: number
  error: string | null
}> {
  const started = Date.now()
  const token = resolveTelegramBotToken()
  const url = token ? `https://api.telegram.org/bot${token}/getMe` : 'https://api.telegram.org/'
  try {
    await axios.get(url, {
      timeout: timeoutMs,
      httpAgent: agent ?? undefined,
      httpsAgent: agent ?? undefined,
      proxy: false,
      validateStatus: (status) => status < 500,
    })
    return { ok: true, ms: Date.now() - started, error: null }
  } catch (err: unknown) {
    return { ok: false, ms: Date.now() - started, error: extractError(err) }
  }
}

function snapshot(partial: {
  telegramOk: boolean
  serverOk: boolean
  latencyMs: number | null
  error: string | null
}): ProxyProbeSnapshot {
  return {
    at: new Date().toISOString(),
    quality: qualityFrom(partial.telegramOk, partial.latencyMs),
    latency_ms: partial.telegramOk ? partial.latencyMs : null,
    telegram_ok: partial.telegramOk,
    server_ok: partial.serverOk,
    error: partial.telegramOk ? null : partial.error,
  }
}

export async function probeDirectTelegram(): Promise<ProxyProbeSnapshot> {
  const result = await probeTelegramApi(null, PROBE_TIMEOUT_MS)
  const probe = snapshot({
    telegramOk: result.ok,
    serverOk: result.ok,
    latencyMs: result.ms,
    error: result.error,
  })
  await telegramProxyStore.setDirectProbe(probe)
  return probe
}

async function probeThroughAgent(
  serverOk: boolean,
  agent: HttpAgent,
): Promise<ProxyProbeSnapshot> {
  const telegram = await probeTelegramApi(agent, PROBE_TIMEOUT_MS)
  return snapshot({
    telegramOk: telegram.ok,
    serverOk: serverOk || telegram.ok,
    latencyMs: telegram.ms,
    error: telegram.error,
  })
}

export async function probeProxyRecord(record: TelegramProxyRecord): Promise<ProxyProbeSnapshot> {
  return withProbeLock(() => probeProxyRecordUnlocked(record))
}

async function probeProxyRecordUnlocked(record: TelegramProxyRecord): Promise<ProxyProbeSnapshot> {
  const server = await tcpPing(record.host, record.port, TCP_TIMEOUT_MS)
  try {
    let probe: ProxyProbeSnapshot
    if (record.kind === 'socks5') {
      probe = await probeThroughAgent(
        server.ok,
        createSocksAgent(record.host, record.port, record.username, record.password),
      )
    } else if (record.kind === 'http') {
      probe = await probeThroughAgent(
        server.ok,
        createHttpProxyAgent(record.host, record.port, record.username, record.password),
      )
    } else {
      const parsed = parseVlessUri(record.uri)
      const state = telegramProxyStore.getState()
      const active = telegramProxyStore.getActive()
      if (active?.id === record.id && isMainTunnelRunning() && getTelegramProxyAgents()) {
        probe = await probeThroughAgent(server.ok, createSocksAgent('127.0.0.1', state.localSocksPort))
      } else {
        const probePort = state.localSocksPort === 10809 ? 10810 : 10809
        probe = await withTempVlessSocks(parsed, probePort, async (port) =>
          probeThroughAgent(server.ok, createSocksAgent('127.0.0.1', port)),
        )
      }
    }
    await telegramProxyStore.setItemProbe(record.id, probe)
    return probe
  } catch (err: unknown) {
    const probe = snapshot({
      telegramOk: false,
      serverOk: server.ok,
      latencyMs: null,
      error: err instanceof Error ? err.message : String(err),
    })
    await telegramProxyStore.setItemProbe(record.id, probe)
    return probe
  }
}

export async function probeAllTelegramProxies(): Promise<{
  direct: ProxyProbeSnapshot
  proxies: Array<{ id: string; probe: ProxyProbeSnapshot }>
}> {
  const direct = await probeDirectTelegram()
  const proxies: Array<{ id: string; probe: ProxyProbeSnapshot }> = []
  for (const item of telegramProxyStore.getState().proxies) {
    const probe = await probeProxyRecord(item)
    proxies.push({ id: item.id, probe })
  }
  return { direct, proxies }
}
