export type AdminLogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG' | 'UNKNOWN';
export interface AdminLogEntry {
    ts: string;
    level: AdminLogLevel;
    message: string;
    extra?: unknown;
    raw: string;
}
export declare function normalizeLogExtra(extra: unknown): unknown;
/** Строка для буфера админки и data/runtime.log (JSON Lines). */
export declare function serializeAdminLogLine(level: string, message: string, extra?: unknown): string;
export declare function parseAdminLogLine(raw: string): AdminLogEntry | null;
export declare function formatAdminLogExtra(extra: unknown): string;
