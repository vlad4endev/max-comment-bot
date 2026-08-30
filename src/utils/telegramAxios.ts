import axios from 'axios'

import { getTelegramProxyAgents } from './telegramProxyRuntime'

export const telegramAxios = axios.create()

telegramAxios.interceptors.request.use((config) => {
  const agents = getTelegramProxyAgents()
  if (agents) {
    config.httpAgent = agents.httpAgent
    config.httpsAgent = agents.httpsAgent
    config.proxy = false
  }
  return config
})
