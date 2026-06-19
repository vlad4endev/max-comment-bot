import Database from 'better-sqlite3';
export declare const ANTISPAM_DB_PATH: string;
export type AntispamSource = 'max' | 'telegram' | 'vk';
export declare function getAntispamDb(): Database.Database;
export declare function getAntispamDbMeta(key: string): string | null;
export declare function setAntispamDbMeta(key: string, value: string): void;
export declare function closeAntispamDb(): void;
