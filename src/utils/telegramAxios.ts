import type { Agent as HttpAgent } from 'node:http'

import axios, { type AxiosInstance } from 'axios'

import { getTelegramPollProxyAgents, getTelegramProxyAgents } from './telegramProxyRuntime'

function attachProxyInterceptor(
  client: AxiosInstance,
  getAgents: () => { httpAgent: HttpAgent; httpsAgent: HttpAgent } | null,
): void {
  client.interceptors.request.use((config) => {
    const agents = getAgents()
    if (agents) {
      config.httpAgent = agents.httpAgent
      config.httpsAgent = agents.httpsAgent
      config.proxy = false
    }
    return config
  })
}

export const telegramAxios = axios.create()
attachProxyInterceptor(telegramAxios, getTelegramProxyAgents)

/** Только long-poll getUpdates: отдельный SOCKS-агент, не делит очередь с sendMessage. */
export const telegramPollAxios = axios.create()
attachProxyInterceptor(telegramPollAxios, getTelegramPollProxyAgents)
