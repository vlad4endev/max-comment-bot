import type { Agent as HttpAgent } from 'node:http'

import axios, { type AxiosInstance } from 'axios'

import {
  getTelegramPollProxyAgents,
  getTelegramProxyAgents,
  getTelegramProxyApplyError,
  isTelegramProxyRequired,
} from './telegramProxyRuntime'

function attachProxyInterceptor(
  client: AxiosInstance,
  getAgents: () => { httpAgent: HttpAgent; httpsAgent: HttpAgent } | null,
): void {
  client.interceptors.request.use((config) => {
    config.family = 4
    const agents = getAgents()
    if (agents) {
      config.httpAgent = agents.httpAgent
      config.httpsAgent = agents.httpsAgent
      config.proxy = false
      return config
    }
    if (isTelegramProxyRequired()) {
      const reason = getTelegramProxyApplyError()
      return Promise.reject(
        new Error(
          `Telegram proxy включён, но туннель не поднят${reason ? `: ${reason}` : ''}. Прямые запросы к api.telegram.org отключены.`,
        ),
      )
    }
    return config
  })
}

export const telegramAxios = axios.create({ family: 4, timeout: 20_000 })
attachProxyInterceptor(telegramAxios, getTelegramProxyAgents)

/** Только long-poll getUpdates: отдельный SOCKS-агент, не делит очередь с sendMessage. */
export const telegramPollAxios = axios.create({ family: 4 })
attachProxyInterceptor(telegramPollAxios, getTelegramPollProxyAgents)
