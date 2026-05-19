export type AdminLogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG' | 'UNKNOWN'

export interface AdminLogEntry {
  ts: string
  level: AdminLogLevel
  message: string
  extra?: unknown
  raw: string
}

const ANSI_RE = /\x1b\[[0-9;]*m/g
const LEGACY_RE =
  /^(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)\s+\[(INFO|WARN|ERROR|DEBUG)\]\s+(.*)$/

export function normalizeLogExtra(extra: unknown): unknown {
  if (extra instanceof Error) {
    return { name: extra.name, message: extra.message, stack: extra.stack }
  }
  return extra
}

/** Строка для буфера админки и data/runtime.log (JSON Lines). */
export function serializeAdminLogLine(level: string, message: string, extra?: unknown): string {
  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    message,
  }
  if (extra !== undefined) {
    record.extra = normalizeLogExtra(extra)
  }
  return JSON.stringify(record)
}

function normalizeLevel(level: string): AdminLogLevel {
  const u = level.toUpperCase()
  if (u === 'INFO' || u === 'WARN' || u === 'ERROR' || u === 'DEBUG') {
    return u
  }
  return 'UNKNOWN'
}

function tryParseTrailingJson(text: string): { message: string; extra?: unknown } {
  const idx = text.lastIndexOf(' {')
  if (idx === -1) {
    return { message: text }
  }
  const candidate = text.slice(idx + 1)
  try {
    const extra = JSON.parse(candidate) as unknown
    return { message: text.slice(0, idx).trimEnd(), extra }
  } catch {
    return { message: text }
  }
}

export function parseAdminLogLine(raw: string): AdminLogEntry | null {
  const line = raw.replace(ANSI_RE, '').trim()
  if (!line) {
    return null
  }

  if (line.startsWith('{')) {
    try {
      const j = JSON.parse(line) as Record<string, unknown>
      return {
        ts: String(j.ts ?? j.timestamp ?? ''),
        level: normalizeLevel(String(j.level ?? 'UNKNOWN')),
        message: String(j.message ?? j.msg ?? ''),
        extra: j.extra,
        raw,
      }
    } catch {
      return { ts: '', level: 'UNKNOWN', message: line, raw }
    }
  }

  const m = line.match(LEGACY_RE)
  if (!m) {
    return { ts: '', level: 'UNKNOWN', message: line, raw }
  }

  const { message, extra } = tryParseTrailingJson(m[3])
  return {
    ts: m[1],
    level: normalizeLevel(m[2]),
    message,
    extra,
    raw,
  }
}

export function formatAdminLogExtra(extra: unknown): string {
  if (extra === undefined || extra === null) {
    return ''
  }
  if (typeof extra === 'string') {
    return extra
  }
  try {
    return JSON.stringify(extra, null, 2)
  } catch {
    return String(extra)
  }
}
