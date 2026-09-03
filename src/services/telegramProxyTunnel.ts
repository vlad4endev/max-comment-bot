import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { chmod, mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { homedir } from 'node:os'
import { dirname, join, delimiter } from 'node:path'

import { logger } from '../utils/logger'
import {
  buildHysteriaClientYaml,
  buildXrayConfig,
  type ParsedTunnelInput,
} from '../utils/vlessUri'

const MAIN_XRAY_CONFIG = join(process.cwd(), 'data', 'xray-telegram.json')
const PROBE_XRAY_CONFIG = join(process.cwd(), 'data', 'xray-telegram-probe.json')
const MAIN_HYSTERIA_CONFIG = join(process.cwd(), 'data', 'hysteria-telegram.yaml')
const PROBE_HYSTERIA_CONFIG = join(process.cwd(), 'data', 'hysteria-telegram-probe.yaml')

export type TunnelEngine = 'xray' | 'hysteria'

let mainChild: ChildProcess | null = null
let mainPort: number | null = null
let mainEngine: TunnelEngine | null = null

function findInPath(name: string): string | null {
  const pathEnv = process.env.PATH ?? ''
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue
    const full = join(dir, name)
    if (existsSync(full)) {
      return full
    }
  }
  return null
}

function firstExisting(candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate
    }
  }
  return null
}

export function findXrayBinary(): string | null {
  const env = (process.env.XRAY_BIN || '').trim()
  return firstExisting([
    env,
    findInPath('xray'),
    '/opt/homebrew/bin/xray',
    '/usr/local/bin/xray',
    '/usr/bin/xray',
    join(process.cwd(), 'bin', 'xray'),
  ])
}

function hysteriaNameCandidates(): string[] {
  const names = ['hysteria', 'hysteria2', 'hy2']
  if (process.platform === 'win32') {
    return names.flatMap((name) => [name, `${name}.exe`])
  }
  return names
}

export function findHysteriaBinary(): string | null {
  const env = (process.env.HYSTERIA_BIN || '').trim()
  const names = hysteriaNameCandidates()
  const home = homedir()
  const extraDirs = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    join(home, '.local', 'bin'),
    join(home, 'bin'),
    join(process.cwd(), 'bin'),
  ]
  const extraFiles = extraDirs.flatMap((dir) => names.map((name) => join(dir, name)))
  const fromPath = names.map((name) => findInPath(name))
  const bundled = listBundledHysteria()
  return firstExisting([env, ...fromPath, ...extraFiles, ...bundled])
}

function listBundledHysteria(): string[] {
  const dir = join(process.cwd(), 'bin')
  if (!existsSync(dir)) {
    return []
  }
  try {
    return readdirSync(dir)
      .filter((name) => /^hysteria/i.test(name) && !name.endsWith('.tmp'))
      .map((name) => join(dir, name))
  } catch {
    return []
  }
}

const HYSTERIA_RELEASE = 'app/v2.12.2'
const HYSTERIA_UA = 'max-comment-bot-hysteria'
const HYSTERIA_MIN_BYTES = 1_000_000

function hysteriaAssetFilename(): string {
  const platform = process.platform
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'amd64' : ''
  if (!arch || (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32')) {
    throw new Error(`Нет готового клиента Hysteria2 для ${process.platform}/${process.arch}`)
  }
  const osName = platform === 'win32' ? 'windows' : platform
  return platform === 'win32' ? `hysteria-${osName}-${arch}.exe` : `hysteria-${osName}-${arch}`
}

function hysteriaDownloadUrls(filename: string): string[] {
  const pinned = `hysteria/releases/download/${HYSTERIA_RELEASE}/${filename}`
  const latest = `hysteria/releases/latest/download/${filename}`
  const github = [
    `https://github.com/HyNetworks/${pinned}`,
    `https://github.com/apernet/${pinned}`,
    `https://github.com/apernet/${latest}`,
  ]
  const proxies = ['https://ghfast.top/', 'https://gh-proxy.com/', 'https://ghproxy.net/', 'https://mirror.ghproxy.com/']
  return [...github, ...proxies.flatMap((prefix) => github.slice(0, 2).map((url) => `${prefix}${url}`))]
}

function spawnOnce(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    const errChunks: Buffer[] = []
    child.stderr?.on('data', (buf: Buffer) => {
      errChunks.push(buf)
    })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      const stderr = Buffer.concat(errChunks).toString('utf8').trim().slice(0, 180)
      reject(new Error(`${command} exited ${code}${stderr ? `: ${stderr}` : ''}`))
    })
  })
}

async function curlDownload(url: string, dest: string): Promise<void> {
  const base = ['-fsSL', '--connect-timeout', '15', '--max-time', '180', '-A', HYSTERIA_UA, '-o', dest, url]
  try {
    await spawnOnce('curl', ['-4', ...base])
  } catch {
    await spawnOnce('curl', base)
  }
}

async function fetchDownload(url: string, dest: string): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 180_000)
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': HYSTERIA_UA },
    })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.byteLength < HYSTERIA_MIN_BYTES) {
      throw new Error(`файл слишком маленький (${buffer.byteLength} байт)`)
    }
    await writeFile(dest, buffer)
  } finally {
    clearTimeout(timer)
  }
}

async function downloadUrlToFile(url: string, dest: string): Promise<void> {
  const curlBin = findInPath('curl')
  if (curlBin) {
    await curlDownload(url, dest)
    return
  }
  await fetchDownload(url, dest)
}

let hysteriaDownload: Promise<string> | null = null

async function downloadHysteriaBinary(): Promise<string> {
  const destDir = join(process.cwd(), 'bin')
  const dest = join(destDir, process.platform === 'win32' ? 'hysteria.exe' : 'hysteria')
  const filename = hysteriaAssetFilename()
  const urls = hysteriaDownloadUrls(filename)
  await mkdir(destDir, { recursive: true })
  const tmp = `${dest}.tmp`
  const errors: string[] = []
  for (const url of urls) {
    logger.info('[telegramProxy] downloading hysteria client', { url })
    try {
      await downloadUrlToFile(url, tmp)
      const { size } = await stat(tmp)
      if (size < HYSTERIA_MIN_BYTES) {
        throw new Error(`файл слишком маленький (${size} байт)`)
      }
      await chmod(tmp, 0o755)
      await rename(tmp, dest)
      if (process.platform === 'darwin') {
        await spawnOnce('xattr', ['-d', 'com.apple.quarantine', dest]).catch(() => undefined)
      }
      logger.info('[telegramProxy] hysteria client ready', { dest, bytes: size })
      return dest
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err)
      errors.push(`${url}: ${detail}`)
      logger.warn('[telegramProxy] hysteria download failed', { url, error: detail })
      await unlink(tmp).catch(() => undefined)
    }
  }
  throw new Error(
    `GitHub недоступен (${errors[0] ?? 'fetch failed'}). Положите бинарник в bin/hysteria или задайте HYSTERIA_BIN.`,
  )
}

export async function ensureHysteriaBinary(): Promise<string> {
  const existing = findHysteriaBinary()
  if (existing) {
    return existing
  }
  if (!hysteriaDownload) {
    hysteriaDownload = downloadHysteriaBinary().catch((err: unknown) => {
      hysteriaDownload = null
      throw err
    })
  }
  return hysteriaDownload
}

export function isXrayAvailable(): boolean {
  return findXrayBinary() !== null
}

export function isHysteriaAvailable(): boolean {
  return findHysteriaBinary() !== null
}

function waitForLocalPort(
  port: number,
  timeoutMs: number,
  label: string,
  child?: ChildProcess,
  getLogs?: () => string,
): Promise<void> {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (err?: Error) => {
      if (settled) return
      settled = true
      if (err) reject(err)
      else resolve()
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      const logs = getLogs?.().trim()
      finish(
        new Error(
          `${label} вышел до SOCKS (code=${code ?? 'null'} signal=${signal ?? 'null'})${logs ? `: ${logs}` : ''}`,
        ),
      )
    }
    child?.once('exit', onExit)
    const tryOnce = (): void => {
      if (settled) return
      const socket = net.connect({ host: '127.0.0.1', port })
      socket.once('connect', () => {
        socket.end()
        child?.off('exit', onExit)
        finish()
      })
      socket.once('error', () => {
        socket.destroy()
        if (settled) return
        if (Date.now() - started > timeoutMs) {
          child?.off('exit', onExit)
          const logs = getLogs?.().trim()
          finish(new Error(`${label} не открыл локальный SOCKS-порт${logs ? `: ${logs}` : ''}`))
          return
        }
        setTimeout(tryOnce, 120)
      })
    }
    tryOnce()
  })
}

async function stopProcess(child: ChildProcess | null): Promise<void> {
  if (!child || child.killed || child.exitCode !== null) {
    return
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve()
    }, 2500)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    child.kill('SIGTERM')
  })
}

function attachLogs(child: ChildProcess, tag: string, socksPort: number): () => string {
  const chunks: string[] = []
  const take = (buf: Buffer) => {
    const text = buf.toString('utf8').trim()
    if (!text) return
    chunks.push(text.slice(0, 400))
    logger.warn(`[${tag}]`, { text: text.slice(0, 400) })
  }
  child.stdout?.on('data', take)
  child.stderr?.on('data', take)
  child.on('exit', (code, signal) => {
    logger.info(`[${tag}] process exited`, { code, signal, port: socksPort })
  })
  return () => chunks.join('\n').slice(-800)
}

async function spawnXray(
  configPath: string,
  parsed: ParsedTunnelInput,
  socksPort: number,
): Promise<ChildProcess> {
  const bin = findXrayBinary()
  if (!bin) {
    throw new Error('Не найден xray-core. Установите его или укажите XRAY_BIN, либо используйте socks5://')
  }
  const dir = dirname(configPath)
  await mkdir(dir, { recursive: true })
  await writeFile(configPath, `${JSON.stringify(buildXrayConfig(parsed, socksPort), null, 2)}\n`, 'utf8')
  const child = spawn(bin, ['run', '-c', configPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const getXrayLogs = attachLogs(child, 'xray', socksPort)
  try {
    await waitForLocalPort(socksPort, 8000, 'xray-core', child, getXrayLogs)
  } catch (err) {
    await stopProcess(child)
    if (parsed.kind === 'hysteria2') {
      throw new Error(
        'xray-core не поднял Hysteria2. Нужен xray-core 26+ или клиент hysteria (HYSTERIA_BIN)',
      )
    }
    throw err
  }
  return child
}

async function spawnHysteriaClient(
  configPath: string,
  parsed: Extract<ParsedTunnelInput, { kind: 'hysteria2' }>,
  socksPort: number,
): Promise<ChildProcess> {
  let bin: string
  try {
    bin = await ensureHysteriaBinary()
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(
      `Не найден клиент Hysteria2. Укажите HYSTERIA_BIN или положите hysteria в bin/. ${detail}`,
    )
  }
  const dir = dirname(configPath)
  await mkdir(dir, { recursive: true })
  await writeFile(configPath, buildHysteriaClientYaml(parsed, socksPort), 'utf8')
  logger.info('[telegramProxy] hysteria config written', {
    server: parsed.server,
    hasAuth: Boolean(parsed.auth),
    sni: parsed.sni || null,
    socksPort,
  })
  const tryArgs = [
    ['client', '-c', configPath],
    ['-c', configPath],
  ]
  let lastError: Error | null = null
  for (const args of tryArgs) {
    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const getLogs = attachLogs(child, 'hysteria', socksPort)
    try {
      await waitForLocalPort(socksPort, 12_000, 'hysteria', child, getLogs)
      return child
    } catch (err) {
      await stopProcess(child)
      lastError = err instanceof Error ? err : new Error(String(err))
      logger.warn('[telegramProxy] hysteria spawn failed', { args, error: lastError.message })
    }
  }
  throw lastError ?? new Error('hysteria не открыл локальный SOCKS-порт')
}

async function spawnTunnel(
  tag: 'main' | 'probe',
  parsed: ParsedTunnelInput,
  socksPort: number,
): Promise<{ child: ChildProcess; engine: TunnelEngine }> {
  if (parsed.kind === 'hysteria2') {
    const child = await spawnHysteriaClient(
      tag === 'main' ? MAIN_HYSTERIA_CONFIG : PROBE_HYSTERIA_CONFIG,
      parsed,
      socksPort,
    )
    return { child, engine: 'hysteria' }
  }
  const child = await spawnXray(tag === 'main' ? MAIN_XRAY_CONFIG : PROBE_XRAY_CONFIG, parsed, socksPort)
  return { child, engine: 'xray' }
}

export async function stopMainVlessTunnel(): Promise<void> {
  await stopProcess(mainChild)
  mainChild = null
  mainPort = null
  mainEngine = null
}

export async function startMainVlessTunnel(parsed: ParsedTunnelInput, socksPort: number): Promise<void> {
  await stopMainVlessTunnel()
  const started = await spawnTunnel('main', parsed, socksPort)
  mainChild = started.child
  mainPort = socksPort
  mainEngine = started.engine
  logger.info('[telegramProxy] tunnel started', {
    kind: parsed.kind,
    engine: started.engine,
    host: parsed.host,
    port: parsed.port,
    socksPort,
  })
}

export function isMainTunnelRunning(): boolean {
  return mainChild !== null && mainChild.exitCode === null && mainPort !== null
}

export function getMainTunnelPort(): number | null {
  return mainPort
}

export function getMainTunnelEngine(): TunnelEngine | null {
  return mainEngine
}

export async function withTempVlessSocks<T>(
  parsed: ParsedTunnelInput,
  socksPort: number,
  run: (port: number) => Promise<T>,
): Promise<T> {
  const started = await spawnTunnel('probe', parsed, socksPort)
  try {
    return await run(socksPort)
  } finally {
    await stopProcess(started.child)
  }
}
