import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const CONFIG_PATH = join(process.cwd(), 'data', 'mtproto-config.json')

export interface MtprotoConfigFile {
  apiId: number
  apiHash: string
  session: string
  phone?: string
  userId?: string
  userDisplay?: string
  updatedAt?: string
}

export type MtprotoCredentialSource = 'file' | 'env' | 'mixed' | 'none'

export interface ResolvedMtprotoCredentials {
  apiId: number | null
  apiHash: string
  session: string
  source: MtprotoCredentialSource
}

function ensureDataDir(): void {
  const dir = dirname(CONFIG_PATH)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

export function readMtprotoConfigFile(): MtprotoConfigFile | null {
  if (!existsSync(CONFIG_PATH)) {
    return null
  }
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf8')
    const parsed = JSON.parse(raw) as Partial<MtprotoConfigFile>
    const apiId = typeof parsed.apiId === 'number' ? parsed.apiId : Number.parseInt(String(parsed.apiId ?? ''), 10)
    const apiHash = typeof parsed.apiHash === 'string' ? parsed.apiHash.trim() : ''
    const session = typeof parsed.session === 'string' ? parsed.session.trim() : ''
    if (!Number.isFinite(apiId) || !apiHash) {
      return null
    }
    return {
      apiId,
      apiHash,
      session,
      phone: typeof parsed.phone === 'string' ? parsed.phone : undefined,
      userId: typeof parsed.userId === 'string' ? parsed.userId : undefined,
      userDisplay: typeof parsed.userDisplay === 'string' ? parsed.userDisplay : undefined,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : undefined,
    }
  } catch {
    return null
  }
}

export function writeMtprotoConfigFile(patch: Partial<MtprotoConfigFile>): MtprotoConfigFile {
  ensureDataDir()
  const prev = readMtprotoConfigFile()
  const apiId =
    typeof patch.apiId === 'number' && Number.isFinite(patch.apiId)
      ? patch.apiId
      : prev?.apiId ?? NaN
  const apiHash = patch.apiHash !== undefined ? patch.apiHash.trim() : (prev?.apiHash ?? '')
  const session = patch.session !== undefined ? patch.session.trim() : (prev?.session ?? '')
  if (!Number.isFinite(apiId) || !apiHash) {
    throw new Error('Нужны api_id и api_hash')
  }
  const next: MtprotoConfigFile = {
    apiId,
    apiHash,
    session,
    phone: patch.phone !== undefined ? patch.phone : prev?.phone,
    userId: patch.userId !== undefined ? patch.userId : prev?.userId,
    userDisplay: patch.userDisplay !== undefined ? patch.userDisplay : prev?.userDisplay,
    updatedAt: new Date().toISOString(),
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8')
  return next
}

export function clearMtprotoSession(): void {
  const prev = readMtprotoConfigFile()
  if (!prev) {
    return
  }
  writeMtprotoConfigFile({
    ...prev,
    session: '',
    phone: undefined,
    userId: undefined,
    userDisplay: undefined,
  })
}

export function deleteMtprotoConfigFile(): void {
  if (existsSync(CONFIG_PATH)) {
    unlinkSync(CONFIG_PATH)
  }
}

function envApiId(): number | null {
  const raw = (process.env.TG_API_ID || '').trim()
  if (!raw) return null
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) ? n : null
}

function envApiHash(): string {
  return (process.env.TG_API_HASH || '').trim()
}

function envSession(): string {
  return (process.env.TG_USER_SESSION || '').trim()
}

export function resolveMtprotoCredentials(): ResolvedMtprotoCredentials {
  const file = readMtprotoConfigFile()
  const fromEnv = {
    apiId: envApiId(),
    apiHash: envApiHash(),
    session: envSession(),
  }
  const apiId = file?.apiId ?? fromEnv.apiId
  const apiHash = file?.apiHash || fromEnv.apiHash
  const session = file?.session || fromEnv.session

  const fileUsed = !!(file?.apiId && file.apiHash)
  const envUsed = !!(fromEnv.apiId && fromEnv.apiHash) || !!fromEnv.session
  let source: MtprotoCredentialSource = 'none'
  if (fileUsed && envUsed) {
    source = 'mixed'
  } else if (fileUsed) {
    source = 'file'
  } else if (envUsed) {
    source = 'env'
  }

  return { apiId: apiId ?? null, apiHash, session, source }
}

/** User-сессия из админки (data/mtproto-config.json) или .env — для MTProto API. */
export function isMtprotoSessionReady(): boolean {
  const { apiId, apiHash, session } = resolveMtprotoCredentials()
  return apiId !== null && apiHash !== '' && session !== ''
}

export function maskPhone(phone: string): string {
  const p = phone.trim()
  if (p.length <= 4) return '••••'
  return `${p.slice(0, Math.min(4, p.length))}•••${p.slice(-2)}`
}
