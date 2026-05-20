/**
 * Однократный перенос автопостов из admin-panel-state.json в SQLite.
 * Старые записи (MAX chat_id) сохраняются как target_channel_id; для TG нужно пересоздать в админке.
 */
export declare function migrateAutopostsFromJson(): void;
