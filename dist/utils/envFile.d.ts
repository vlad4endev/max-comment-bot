/**
 * Добавляет или обновляет переменную в корневом `.env`.
 */
export declare function upsertRootEnvVar(key: string, value: string): Promise<void>;
/**
 * Удаляет переменную из корневого `.env`.
 */
export declare function removeRootEnvVar(key: string): Promise<void>;
