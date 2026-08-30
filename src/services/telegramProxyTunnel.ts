import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises'
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

function hysteriaDownloadAsset(): { filename: string; url: string } {
  const platform = process.platform
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'amd64' : ''
  if (!arch || (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32')) {
    throw new Error(`Нет готового клиента Hysteria2 для ${process.platform}/${process.arch}`)
  }
  const osName = platform === 'win32' ? 'windows' : platform
  const filename = platform === 'win32' ? `hysteria-${osName}-${arch}.exe` : `hysteria-${osName}-${arch}`
  return {
    filename,
    url: `https://github.com/apernet/hysteria/releases/latest/download/${filename}`,
  }
}

let hysteriaDownload: Promise<string> | null = null

async function downloadHysteriaBinary(): Promise<string> {
  const destDir = join(process.cwd(), 'bin')
  const dest = join(destDir, process.platform === 'win32' ? 'hysteria.exe' : 'hysteria')
  const { url, filename } = hysteriaDownloadAsset()
  logger.info('[telegramProxy] downloading hysteria client', { url })
  const response = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'max-comment-bot-hysteria' },
  })
  if (!response.ok) {
    throw new Error(`Не удалось скачать ${filename}: HTTP ${response.status}`)
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.byteLength < 1_000_000) {
    throw new Error('Скачанный файл hysteria повреждён или слишком маленький')
  }
  await mkdir(destDir, { recursive: true })
  const tmp = `${dest}.tmp`
  await writeFile(tmp, buffer)
  await chmod(tmp, 0o755)
  await rename(tmp, dest)
  if (process.platform === 'darwin') {
    await new Promise<void>((resolve) => {
      const child = spawn('xattr', ['-d', 'com.apple.quarantine', dest], { stdio: 'ignore' })
      child.once('exit', () => resolve())
      child.once('error', () => resolve())
    })
  }
  logger.info('[telegramProxy] hysteria client ready', { dest, bytes: buffer.byteLength })
  return dest
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

function waitForLocalPort(port: number, timeoutMs: number, label: string): Promise<void> {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const tryOnce = (): void => {
      const socket = net.connect({ host: '127.0.0.1', port })
      socket.once('connect', () => {
        socket.end()
        resolve()
      })
      socket.once('error', () => {
        socket.destroy()
        if (Date.now() - started > timeoutMs) {
          reject(new Error(`${label} не открыл локальный SOCKS-порт`))
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

function attachLogs(child: ChildProcess, tag: string, socksPort: number): void {
  child.stderr?.on('data', (buf: Buffer) => {
    const text = buf.toString('utf8').trim()
    if (text) {
      logger.warn(`[${tag}]`, { text: text.slice(0, 400) })
    }
  })
  child.on('exit', (code, signal) => {
    logger.info(`[${tag}] process exited`, { code, signal, port: socksPort })
  })
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
  attachLogs(child, 'xray', socksPort)
  try {
    await waitForLocalPort(socksPort, 8000, 'xray-core')
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
  const tryArgs = [
    ['-c', configPath],
    ['client', '-c', configPath],
  ]
  let lastError: Error | null = null
  for (const args of tryArgs) {
    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    attachLogs(child, 'hysteria', socksPort)
    try {
      await waitForLocalPort(socksPort, 12_000, 'hysteria')
      return child
    } catch (err) {
      await stopProcess(child)
      lastError = err instanceof Error ? err : new Error(String(err))
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
