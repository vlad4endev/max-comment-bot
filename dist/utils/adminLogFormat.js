"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeLogExtra = normalizeLogExtra;
exports.serializeAdminLogLine = serializeAdminLogLine;
exports.parseAdminLogLine = parseAdminLogLine;
exports.formatAdminLogExtra = formatAdminLogExtra;
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const LEGACY_RE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)\s+\[(INFO|WARN|ERROR|DEBUG)\]\s+(.*)$/;
function normalizeLogExtra(extra) {
    if (extra instanceof Error) {
        return { name: extra.name, message: extra.message, stack: extra.stack };
    }
    return extra;
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