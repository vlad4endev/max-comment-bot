import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { dirname, join, delimiter } from 'node:path'

import { logger } from '../utils/logger'
import { buildXrayConfig, type ParsedVless } from '../utils/vlessUri'

const MAIN_CONFIG_PATH = join(process.cwd(), 'data', 'xray-telegram.json')
const PROBE_CONFIG_PATH = join(process.cwd(), 'data', 'xray-telegram-probe.json')

let mainChild: ChildProcess | null = null
let mainPort: number | null = null

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

export function findXrayBinary(): string | null {
  const env = (process.env.XRAY_BIN || '').trim()
  const candidates = [env, findInPath('xray'), '/usr/local/bin/xray', '/usr/bin/xray', join(process.cwd(), 'bin', 'xray')]
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate
    }
  }
  return null
}

export function isXrayAvailable(): boolean {
  return findXrayBinary() !== null
}

function waitForLocalPort(port: number, timeoutMs: number): Promise<void> {
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
          reject(new Error('xray-core не открыл локальный SOCKS-порт'))
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

async function spawnXray(configPath: string, parsed: ParsedVless, socksPort: number): Promise<ChildProcess> {
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
  child.stderr?.on('data', (buf: Buffer) => {
    const text = buf.toString('utf8').trim()
    if (text) {
      logger.warn('[xray]', { text: text.slice(0, 400) })
    }
  })
  child.on('exit', (code, signal) => {
    logger.info('[xray] process exited', { code, signal, port: socksPort })
  })
  try {
    await waitForLocalPort(socksPort, 8000)
  } catch (err) {
    await stopProcess(child)
    throw err
  }
  return child
}

export async function stopMainVlessTunnel(): Promise<void> {
  await stopProcess(mainChild)
  mainChild = null
  mainPort = null
}

export async function startMainVlessTunnel(parsed: ParsedVless, socksPort: number): Promise<void> {
  await stopMainVlessTunnel()
  mainChild = await spawnXray(MAIN_CONFIG_PATH, parsed, socksPort)
  mainPort = socksPort
  logger.info('[telegramProxy] VLESS tunnel started', { host: parsed.host, port: parsed.port, socksPort })
}

export function isMainTunnelRunning(): boolean {
  return mainChild !== null && mainChild.exitCode === null && mainPort !== null
}

export function getMainTunnelPort(): number | null {
  return mainPort
}

export async function withTempVlessSocks<T>(
  parsed: ParsedVless,
  socksPort: number,
  run: (port: number) => Promise<T>,
): Promise<T> {
  const child = await spawnXray(PROBE_CONFIG_PATH, parsed, socksPort)
  try {
    return await run(socksPort)
  } finally {
    await stopProcess(child)
  }
}
