/**
 * Примеры:
 * logger.info('Бот запущен')
 * logger.error('Ошибка подключения', error)
 * logger.warn('Большой payload', { size: 150 })
 * logger.debug('Переменные окружения загружены')
 */
/** Последние строки консольного лога (и дубль в data/runtime.log при возможности). */
export declare function getAdminLogTail(maxLines: number): string[];
export declare class Logger {
    /**
     * @example logger.info('Бот запущен')
     * @example logger.info('Событие', { id: 1 })
     */
    info(message: string, data?: any): void;
    /**
     * @example logger.error('Ошибка подключения', error)
     */
    error(message: string, error?: any): void;
    /**
     * @example logger.warn('Большой payload', { size: 150 })
     */
    warn(message: string, data?: any): void;
    /**
     * Только при NODE_ENV === 'development'.
     * @example logger.debug('Переменные окружения загружены')
     */
    debug(message: string, data?: any): void;
    private emit;
}
/**
 * @example logger.info('Бот запущен')
 * @example logger.error('Ошибка подключения', error)
 * @example logger.warn('Большой payload', { size: 150 })
 * @example logger.debug('Переменные окружения загружены')
 */
export declare const logger: Logger;
