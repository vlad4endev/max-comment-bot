import Database from 'better-sqlite3';
export declare const POSTS_DB_PATH: string;
export type PostPlatform = 'telegram' | 'max';
export declare function getPostsDb(): Database.Database;
export declare function getPostsDbMeta(key: string): string | null;
export declare function setPostsDbMeta(key: string, value: string): void;
export declare function closePostsDb(): void;
