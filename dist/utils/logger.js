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