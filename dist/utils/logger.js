"use strict";
/**
 * Примеры:
 * logger.info('Бот запущен')
 * logger.error('Ошибка подключения', error)
 * logger.warn('Большой payload', { size: 150 })
 * logger.debug('Переменные окружения загружены')
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.logger = exports.Logger = void 0;
exports.rotateRuntimeLogIfNeeded = rotateRuntimeLogIfNeeded;
exports.startRuntimeLogRotationScheduler = startRuntimeLogRotationScheduler;
exports.stopRuntimeLogRotationScheduler = stopRuntimeLogRotationScheduler;
exports.getAdminLogTail = getAdminLogTail;
const node_fs_1 = require("node:fs");
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const adminLogFormat_1 = require("./adminLogFormat");
const RUNTIME_LOG_PATH = (0, node_path_1.join)(process.cwd(), 'data', 'runtime.log');
const MAX_LOG_SIZE = 50 * 1024 * 1024;
const ADMIN_LOG_BUFFER_MAX = 500;
const adminLogLines = [];
function rotateRuntimeLogIfNeeded() {
    try {
        if (!(0, node_fs_1.existsSync)(RUNTIME_LOG_PATH)) {
            return;
        }
        if ((0, node_fs_1.statSync)(RUNTIME_LOG_PATH).size > MAX_LOG_SIZE) {
            (0, node_fs_1.renameSync)(RUNTIME_LOG_PATH, `${RUNTIME_LOG_PATH}.old`);
        }
    }
    catch {
        /* ignore rotation errors */
    }
}
const LOG_ROTATION_INTERVAL_MS = 60 * 60 * 1000;
let logRotationInterval;
/** Проверка размера при старте и раз в час. */
function startRuntimeLogRotationScheduler() {
    rotateRuntimeLogIfNeeded();
    stopRuntimeLogRotationScheduler();
    logRotationInterval = setInterval(() => {
        rotateRuntimeLogIfNeeded();
    }, LOG_ROTATION_INTERVAL_MS);
}
function stopRuntimeLogRotationScheduler() {
    if (logRotationInterval !== undefined) {
        clearInterval(logRotationInterval);
        logRotationInterval = undefined;
    }
}
function pushAdminLogLine(line) {
    adminLogLines.push(line);
    if (adminLogLines.length > ADMIN_LOG_BUFFER_MAX) {
        adminLogLines.splice(0, adminLogLines.length - ADMIN_LOG_BUFFER_MAX);
    }
    rotateRuntimeLogIfNeeded();
    void (0, promises_1.mkdir)((0, node_path_1.dirname)(RUNTIME_LOG_PATH), { recursive: true })
        .then(() => (0, promises_1.appendFile)(RUNTIME_LOG_PATH, `${line}\n`, 'utf8'))
        .catch(() => {
        /* ignore disk errors for log tail */
    });
}
/** Последние строки консольного лога (и дубль в data/runtime.log при возможности). */
function getAdminLogTail(maxLines) {
    const n = Math.min(Math.max(1, maxLines), adminLogLines.length);
    return adminLogLines.slice(-n);
}
const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const isDevelopment = process.env.NODE_ENV === 'development';
class Logger {
    /**
     * @example logger.info('Бот запущен')
     * @example logger.info('Событие', { id: 1 })
     */
    info(message, data) {
        this.emit('INFO', GREEN, message, console.log, data);
    }
    /**
     * @example logger.error('Ошибка подключения', error)
     */
    error(message, error) {
        this.emit('ERROR', RED, message, console.error, error);
    }
    /**
     * @example logger.warn('Большой payload', { size: 150 })
     */
    warn(message, data) {
        this.emit('WARN', YELLOW, message, console.warn, data);
    }
    /**
     * Только при NODE_ENV === 'development'.
     * @example logger.debug('Переменные окружения загружены')
     */
    debug(message, data) {
        if (!isDevelopment) {
            return;
        }
        this.emit('DEBUG', CYAN, message, console.log, data);
    }
    emit(level, color, message, write, extra) {
        const timestamp = new Date().toISOString();
        const header = `${color}${timestamp} [${level}] ${message}${RESET}`;
        pushAdminLogLine((0, adminLogFormat_1.serializeAdminLogLine)(level, message, extra));
        if (extra !== undefined) {
            write(header, extra);
        }
        else {
            write(header);
        }
    }
}
exports.Logger = Logger;
/**
 * @example logger.info('Бот запущен')
 * @example logger.error('Ошибка подключения', error)
 * @example logger.warn('Большой payload', { size: 150 })
 * @example logger.debug('Переменные окружения загружены')
 */
exports.logger = new Logger();
//# sourceMappingURL=logger.js.map