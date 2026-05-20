"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeLogExtra = normalizeLogExtra;
exports.serializeAdminLogLine = serializeAdminLogLine;
exports.parseAdminLogLine = parseAdminLogLine;
exports.formatAdminLogExtra = formatAdminLogExtra;
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const LEGACY_RE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)\s+\[(INFO|WARN|ERROR|DEBUG)\]\s+(.*)$/;
function isRecord(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function errorToPlain(err) {
    const out = {
        name: err.name,
        message: err.message,
        stack: err.stack,
    };
    const cause = err.cause;
    if (cause !== undefined) {
        out.cause = normalizeLogExtra(cause);
    }
    return out;
}
/** Нормализует extra для JSON Lines: Error, вложенные объекты, циклические ссылки. */
function normalizeLogExtra(extra, depth = 0) {
    if (extra === undefined || extra === null) {
        return extra;
    }
    if (extra instanceof Error) {
        return errorToPlain(extra);
    }
    if (typeof extra === 'bigint') {
        return String(extra);
    }
    if (typeof extra !== 'object') {
        return extra;
    }
    if (depth > 4) {
        return '[max depth]';
    }
    if (Array.isArray(extra)) {
        return extra.map((item) => normalizeLogExtra(item, depth + 1));
    }
    if (isRecord(extra)) {
        const axiosLike = 'response' in extra &&
            isRecord(extra.response) &&
            ('status' in extra.response || 'data' in extra.response);
        if (axiosLike) {
            const res = extra.response;
            return {
                message: extra.message,
                code: extra.code,
                status: res.status,
                statusText: res.statusText,
                data: normalizeLogExtra(res.data, depth + 1),
            };
        }
        const out = {};
        for (const [k, v] of Object.entries(extra)) {
            out[k] = normalizeLogExtra(v, depth + 1);
        }
        return out;
    }
    return String(extra);
}
/** Строка для буфера админки и data/runtime.log (JSON Lines). */
function serializeAdminLogLine(level, message, extra) {
    const record = {
        ts: new Date().toISOString(),
        level,
        message,
    };
    if (extra !== undefined) {
        record.extra = normalizeLogExtra(extra);
    }
    return JSON.stringify(record);
}
function normalizeLevel(level) {
    const u = level.toUpperCase();
    if (u === 'INFO' || u === 'WARN' || u === 'ERROR' || u === 'DEBUG') {
        return u;
    }
    return 'UNKNOWN';
}
function tryParseTrailingJson(text) {
    const idx = text.lastIndexOf(' {');
    if (idx === -1) {
        return { message: text };
    }
    const candidate = text.slice(idx + 1);
    try {
        const extra = JSON.parse(candidate);
        return { message: text.slice(0, idx).trimEnd(), extra };
    }
    catch {
        return { message: text };
    }
}
function parseAdminLogLine(raw) {
    const line = raw.replace(ANSI_RE, '').trim();
    if (!line) {
        return null;
    }
    if (line.startsWith('{')) {
        try {
            const j = JSON.parse(line);
            return {
                ts: String(j.ts ?? j.timestamp ?? ''),
                level: normalizeLevel(String(j.level ?? 'UNKNOWN')),
                message: String(j.message ?? j.msg ?? ''),
                extra: j.extra,
                raw,
            };
        }
        catch {
            return { ts: '', level: 'UNKNOWN', message: line, raw };
        }
    }
    const m = line.match(LEGACY_RE);
    if (!m) {
        return { ts: '', level: 'UNKNOWN', message: line, raw };
    }
    const { message, extra } = tryParseTrailingJson(m[3]);
    return {
        ts: m[1],
        level: normalizeLevel(m[2]),
        message,
        extra,
        raw,
    };
}
function formatAdminLogExtra(extra) {
    if (extra === undefined || extra === null) {
        return '';
    }
    if (typeof extra === 'string') {
        return extra;
    }
    try {
        return JSON.stringify(extra, null, 2);
    }
    catch {
        return String(extra);
    }
}
//# sourceMappingURL=adminLogFormat.js.map