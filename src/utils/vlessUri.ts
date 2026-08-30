export type ProxyKind = 'vless' | 'socks5' | 'http'

export interface ParsedVless {
  kind: 'vless'
  uri: string
  uuid: string
  host: string
  port: number
  name: string
  encryption: string
  flow: string
  network: string
  security: string
  sni: string
  fingerprint: string
  publicKey: string
  shortId: string
  spiderX: string
  path: string
  wsHost: string
  serviceName: string
  alpn: string
  allowInsecure: boolean
}

export interface ParsedSocksHttp {
  kind: 'socks5' | 'http'
  host: string
  port: number
  username: string
  password: string
  name: string
}

export type ParsedProxyInput = ParsedVless | ParsedSocksHttp

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const UUID_HEX_RE = /^[0-9a-f]{32}$/i

function param(params: URLSearchParams, key: string, ...aliases: string[]): string {
  const keys = [key, ...aliases]
  for (const k of keys) {
    const value = params.get(k)
    if (value != null && value.trim() !== '') {
      return value.trim()
    }
  }
  return ''
}

function parseHostPort(hostPort: string, defaultPort: number): { host: string; port: number } {
  const trimmed = hostPort.trim()
  if (!trimmed) {
    throw new Error('Не указан хост прокси')
  }
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']')
    if (end < 0) {
      throw new Error('Некорректный IPv6-адрес в ссылке')
    }
    const host = trimmed.slice(1, end)
    const portPart = trimmed.slice(end + 1)
    const port = portPart.startsWith(':')
      ? Number.parseInt(portPart.slice(1), 10)
      : defaultPort
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      throw new Error('Некорректный порт в ссылке')
    }
    return { host, port }
  }
  const colon = trimmed.lastIndexOf(':')
  if (colon < 0) {
    return { host: trimmed, port: defaultPort }
  }
  const host = trimmed.slice(0, colon)
  const port = Number.parseInt(trimmed.slice(colon + 1), 10)
  if (!host || !Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error('Некорректный хост или порт в ссылке')
  }
  return { host, port }
}

export function parseVlessUri(raw: string): ParsedVless {
  const trimmed = raw.trim()
  if (!/^vless:\/\//i.test(trimmed)) {
    throw new Error('Ожидалась ссылка vless://')
  }
  const hashIndex = trimmed.indexOf('#')
  const withoutHash = hashIndex >= 0 ? trimmed.slice(0, hashIndex) : trimmed
  const name =
    hashIndex >= 0
      ? decodeURIComponent(trimmed.slice(hashIndex + 1).replace(/\+/g, ' ')).trim()
      : ''
  const rest = withoutHash.slice('vless://'.length)
  const at = rest.indexOf('@')
  if (at < 0) {
    throw new Error('В ссылке VLESS нет адреса сервера')
  }
  const uuid = decodeURIComponent(rest.slice(0, at)).trim()
  if (!UUID_RE.test(uuid) && !UUID_HEX_RE.test(uuid)) {
    throw new Error('В ссылке VLESS некорректный UUID')
  }
  const hostPortQuery = rest.slice(at + 1)
  const qIndex = hostPortQuery.indexOf('?')
  const hostPort = qIndex >= 0 ? hostPortQuery.slice(0, qIndex) : hostPortQuery
  const query = qIndex >= 0 ? hostPortQuery.slice(qIndex + 1) : ''
  const params = new URLSearchParams(query)
  const { host, port } = parseHostPort(hostPort, 443)
  const network = (param(params, 'type', 'network', 'net') || 'tcp').toLowerCase()
  const security = (param(params, 'security', 'tls') || 'none').toLowerCase()
  return {
    kind: 'vless',
    uri: trimmed,
    uuid,
    host,
    port,
    name: name || host,
    encryption: param(params, 'encryption') || 'none',
    flow: param(params, 'flow'),
    network: network === 'h2' ? 'http' : network,
    security: security === 'xtls' ? 'tls' : security,
    sni: param(params, 'sni', 'serverName', 'servername'),
    fingerprint: param(params, 'fp', 'fingerprint'),
    publicKey: param(params, 'pbk', 'publicKey', 'publickey'),
    shortId: param(params, 'sid', 'shortId', 'shortid'),
    spiderX: param(params, 'spx', 'spiderX', 'spiderx') || '/',
    path: param(params, 'path'),
    wsHost: param(params, 'host', 'authority'),
    serviceName: param(params, 'serviceName', 'servicename'),
    alpn: param(params, 'alpn'),
    allowInsecure: /^(1|true|yes)$/i.test(param(params, 'allowInsecure', 'allowinsecure', 'insecure')),
  }
}

function parseGenericUrl(raw: string, kind: 'socks5' | 'http', defaultPort: number): ParsedSocksHttp {
  const normalized =
    kind === 'socks5'
      ? raw.replace(/^socks5h?:\/\//i, 'http://').replace(/^socks:\/\//i, 'http://')
      : raw
  let url: URL
  try {
    url = new URL(normalized)
  } catch {
    throw new Error(`Некорректная ссылка ${kind}`)
  }
  const port = url.port ? Number.parseInt(url.port, 10) : defaultPort
  if (!url.hostname || !Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error('Некорректный хост или порт прокси')
  }
  const name = url.hash ? decodeURIComponent(url.hash.slice(1)).trim() : ''
  return {
    kind,
    host: url.hostname,
    port,
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    name: name || url.hostname,
  }
}

export function parseProxyInput(raw: string): ParsedProxyInput {
  const trimmed = raw.trim()
  if (!trimmed) {
    throw new Error('Пустая ссылка')
  }
  if (/^vless:\/\//i.test(trimmed)) {
    return parseVlessUri(trimmed)
  }
  if (/^socks5h?:\/\//i.test(trimmed) || /^socks:\/\//i.test(trimmed)) {
    return parseGenericUrl(trimmed, 'socks5', 1080)
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return parseGenericUrl(trimmed, 'http', /^https:\/\//i.test(trimmed) ? 443 : 80)
  }
  throw new Error('Поддерживаются ссылки vless://, socks5:// и http://')
}

export function parseProxyLines(text: string): ParsedProxyInput[] {
  const lines = text.split(/\r?\n/)
  const parsed: ParsedProxyInput[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }
    parsed.push(parseProxyInput(trimmed))
  }
  if (parsed.length === 0) {
    throw new Error('Не найдено ни одной ссылки vless://, socks5:// или http://')
  }
  return parsed
}

export function buildXrayOutbound(parsed: ParsedVless): Record<string, unknown> {
  const user: Record<string, unknown> = {
    id: parsed.uuid,
    encryption: parsed.encryption || 'none',
  }
  if (parsed.flow) {
    user.flow = parsed.flow
  }

  const streamSettings: Record<string, unknown> = {
    network: parsed.network || 'tcp',
  }

  if (parsed.security === 'reality') {
    streamSettings.security = 'reality'
    streamSettings.realitySettings = {
      show: false,
      fingerprint: parsed.fingerprint || 'chrome',
      serverName: parsed.sni || parsed.host,
      publicKey: parsed.publicKey,
      shortId: parsed.shortId,
      spiderX: parsed.spiderX || '/',
    }
  } else if (parsed.security === 'tls') {
    const tlsSettings: Record<string, unknown> = {
      serverName: parsed.sni || parsed.host,
      allowInsecure: parsed.allowInsecure,
    }
    if (parsed.fingerprint) {
      tlsSettings.fingerprint = parsed.fingerprint
    }
    if (parsed.alpn) {
      tlsSettings.alpn = parsed.alpn
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
    }
    streamSettings.security = 'tls'
    streamSettings.tlsSettings = tlsSettings
  }

  if (parsed.network === 'ws') {
    streamSettings.wsSettings = {
      path: parsed.path || '/',
      headers: parsed.wsHost ? { Host: parsed.wsHost } : {},
    }
  } else if (parsed.network === 'grpc') {
    streamSettings.grpcSettings = {
      serviceName: parsed.serviceName,
    }
  }

  return {
    protocol: 'vless',
    settings: {
      vnext: [
        {
          address: parsed.host,
          port: parsed.port,
          users: [user],
        },
      ],
    },
    streamSettings,
  }
}

export function buildXrayConfig(parsed: ParsedVless, socksPort: number): Record<string, unknown> {
  return {
    log: { loglevel: 'warning' },
    inbounds: [
      {
        tag: 'socks-in',
        listen: '127.0.0.1',
        port: socksPort,
        protocol: 'socks',
        settings: { udp: true, auth: 'noauth' },
      },
    ],
    outbounds: [buildXrayOutbound(parsed), { protocol: 'freedom', tag: 'direct' }],
  }
}
