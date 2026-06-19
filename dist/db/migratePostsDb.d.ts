/**
 * Переносит autoposts из bot.db в posts.db (однократно).
 * После успешного переноса таблица autoposts удаляется из bot.db.
 */
export declare function migrateAutopostsFromBotDb(): void;
