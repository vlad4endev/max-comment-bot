export type ProxyKind = 'vless' | 'hysteria2' | 'socks5' | 'http'

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

export interface ParsedHysteria2 {
  kind: 'hysteria2'
  uri: string
  auth: string
  host: string
  port: number
  server: string
  hopPorts: string
  name: string
  sni: string
  insecure: boolean
  pinSHA256: string
  obfs: string
  obfsPassword: string
}

export interface ParsedSocksHttp {
  kind: 'socks5' | 'http'
  host: string
  port: number
  username: string
  password: string
  name: string
}

export type ParsedTunnelInput = ParsedVless | ParsedHysteria2
export type ParsedProxyInput = ParsedTunnelInput | ParsedSocksHttp

export function looksLikeHysteria2Uri(raw: string): boolean {
  return /^(hysteria2|hy2):\/\//i.test(raw.trim())
}

export function parseTunnelUri(raw: string): ParsedTunnelInput {
  const trimmed = raw.trim()
  if (looksLikeHysteria2Uri(trimmed)) {
    return parseHysteria2Uri(trimmed)
  }
  if (/^vless:\/\//i.test(trimmed)) {
    return parseVlessUri(trimmed)
  }
  throw new Error('Ожидалась ссылка hysteria2://, hy2:// или vless://')
}

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

export function parseHysteria2Uri(raw: string): ParsedHysteria2 {
  const trimmed = raw.trim()
  if (!/^(hysteria2|hy2):\/\//i.test(trimmed)) {
    throw new Error('Ожидалась ссылка hysteria2:// или hy2://')
  }
  const hashIndex = trimmed.indexOf('#')
  const withoutHash = hashIndex >= 0 ? trimmed.slice(0, hashIndex) : trimmed
  const name =
    hashIndex >= 0
      ? decodeURIComponent(trimmed.slice(hashIndex + 1).replace(/\+/g, ' ')).trim()
      : ''
  const schemeEnd = withoutHash.indexOf('://')
  const rest = withoutHash.slice(schemeEnd + 3)
  const at = rest.indexOf('@')
  let auth = ''
  let hostPortQuery = rest
  if (at >= 0) {
    auth = decodeURIComponent(rest.slice(0, at).replace(/\+/g, ' '))
    hostPortQuery = rest.slice(at + 1)
  }
  const qIndex = hostPortQuery.indexOf('?')
  const hostPort = (qIndex >= 0 ? hostPortQuery.slice(0, qIndex) : hostPortQuery).replace(/\/+$/, '')
  const query = qIndex >= 0 ? hostPortQuery.slice(qIndex + 1) : ''
  const params = new URLSearchParams(query)
  if (!auth) {
    auth = decodeURIComponent(param(params, 'auth', 'password').replace(/\+/g, ' '))
  }
  const { host, port, hopPorts, server } = parseHy2Authority(hostPort)
  const obfs = param(params, 'obfs').toLowerCase().replace(/[^a-z0-9-]/g, '')
  const obfsPassword = param(params, 'obfs-password', 'obfsPassword', 'obfspassword')
  return {
    kind: 'hysteria2',
    uri: trimmed,
    auth,
    host,
    port,
    server,
    hopPorts,
    name: name || host,
    sni: param(params, 'sni', 'peer', 'serverName', 'servername'),
    insecure: /^(1|true|yes)$/i.test(param(params, 'insecure', 'insecureTLS', 'insecuretls', 'allowInsecure', 'allowinsecure')),
    pinSHA256: param(params, 'pinSHA256', 'pinsha256', 'pin_sha256'),
    obfs,
    obfsPassword,
  }
}

function parseHy2Authority(hostPort: string): {
  host: string
  port: number
  hopPorts: string
  server: string
} {
  const trimmed = hostPort.trim()
  if (!trimmed) {
    throw new Error('В ссылке Hysteria2 нет адреса сервера')
  }
  let host: string
  let hopPorts: string
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']')
    if (end < 0) {
      throw new Error('Некорректный IPv6-адрес в ссылке Hysteria2')
    }
    host = trimmed.slice(1, end)
    const after = trimmed.slice(end + 1)
    hopPorts = after.startsWith(':') ? after.slice(1).trim() : ''
  } else {
    const colon = trimmed.lastIndexOf(':')
    if (colon < 0) {
      host = trimmed
      hopPorts = ''
    } else {
      host = trimmed.slice(0, colon)
      hopPorts = trimmed.slice(colon + 1).trim()
    }
  }
  if (!host) {
    throw new Error('Некорректный хост в ссылке Hysteria2')
  }
  if (!hopPorts) {
    hopPorts = '443'
  }
  const firstPort = Number.parseInt(hopPorts.split(/[,-]/)[0] ?? '', 10)
  if (!Number.isFinite(firstPort) || firstPort <= 0 || firstPort > 65535) {
    throw new Error('Некорректный порт в ссылке Hysteria2')
  }
  const server = host.includes(':') ? `[${host}]:${hopPorts}` : `${host}:${hopPorts}`
  return { host, port: firstPort, hopPorts, server }
}

export function parseProxyInput(raw: string): ParsedProxyInput {
  const trimmed = raw.trim()
  if (!trimmed) {
    throw new Error('Пустая ссылка')
  }
  if (/^vless:\/\//i.test(trimmed)) {
    return parseVlessUri(trimmed)
  }
  if (/^(hysteria2|hy2):\/\//i.test(trimmed)) {
    return parseHysteria2Uri(trimmed)
  }
  if (/^socks5h?:\/\//i.test(trimmed) || /^socks:\/\//i.test(trimmed)) {
    return parseGenericUrl(trimmed, 'socks5', 1080)
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return parseGenericUrl(trimmed, 'http', /^https:\/\//i.test(trimmed) ? 443 : 80)
  }
  throw new Error('Поддерживаются ссылки hysteria2://, hy2://, vless://, socks5:// и http://')
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
    throw new Error('Не найдено ни одной ссылки hysteria2://, vless://, socks5:// или http://')
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

export function buildXrayHysteriaOutbound(parsed: ParsedHysteria2): Record<string, unknown> {
  const hysteriaSettings: Record<string, unknown> = {
    version: 2,
    auth: parsed.auth,
  }
  if (/[,-]/.test(parsed.hopPorts)) {
    hysteriaSettings.udphop = {
      port: parsed.hopPorts,
      interval: 30,
    }
  }
  const tlsSettings: Record<string, unknown> = {
    serverName: parsed.sni || parsed.host,
    allowInsecure: parsed.insecure,
    alpn: ['h3'],
  }
  if (parsed.pinSHA256) {
    tlsSettings.pinnedPeerCertSha256 = parsed.pinSHA256.replace(/:/g, '').toLowerCase()
  }
  const streamSettings: Record<string, unknown> = {
    network: 'hysteria',
    hysteriaSettings,
    security: 'tls',
    tlsSettings,
  }
  const obfsType = parsed.obfs || (parsed.obfsPassword ? 'salamander' : '')
  if (obfsType) {
    streamSettings.finalmask = {
      udp: [
        {
          type: obfsType,
          settings: parsed.obfsPassword ? { password: parsed.obfsPassword } : {},
        },
      ],
    }
  }
  return {
    protocol: 'hysteria',
    settings: {
      version: 2,
      address: parsed.host,
      port: parsed.port,
    },
    streamSettings,
  }
}

export function buildHysteriaClientYaml(parsed: ParsedHysteria2, socksPort: number): string {
  const lines = [
    `server: ${JSON.stringify(parsed.server)}`,
    `auth: ${JSON.stringify(parsed.auth)}`,
    'socks5:',
    `  listen: ${JSON.stringify(`127.0.0.1:${socksPort}`)}`,
  ]
  const tlsLines: string[] = []
  if (parsed.sni) {
    tlsLines.push(`  sni: ${JSON.stringify(parsed.sni)}`)
  }
  if (parsed.insecure) {
    tlsLines.push('  insecure: true')
  }
  if (parsed.pinSHA256) {
    tlsLines.push(`  pinSHA256: ${JSON.stringify(parsed.pinSHA256)}`)
  }
  if (tlsLines.length > 0) {
    lines.push('tls:')
    lines.push(...tlsLines)
  }
  const obfsType = parsed.obfs || (parsed.obfsPassword ? 'salamander' : '')
  if (obfsType) {
    lines.push('obfs:')
    lines.push(`  type: ${JSON.stringify(obfsType)}`)
    if (parsed.obfsPassword) {
      lines.push(`  ${obfsType}:`)
      lines.push(`    password: ${JSON.stringify(parsed.obfsPassword)}`)
    }
  }
  return `${lines.join('\n')}\n`
}

export function buildXrayConfig(parsed: ParsedTunnelInput, socksPort: number): Record<string, unknown> {
  const outbound = parsed.kind === 'hysteria2' ? buildXrayHysteriaOutbound(parsed) : buildXrayOutbound(parsed)
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
    outbounds: [outbound, { protocol: 'freedom', tag: 'direct' }],
  }
}
