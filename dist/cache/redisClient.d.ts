import Redis from 'ioredis';
export declare function getRedisUrl(): string | null;
export declare function isRedisConfigured(): boolean;
export type RedisInitStatus = 'disabled' | 'connected' | 'unavailable';
export declare function initRedis(): Promise<RedisInitStatus>;
export declare function getRedisClient(): Redis | null;
export declare function pingRedis(): Promise<boolean>;
export declare function disconnectRedis(): Promise<void>;
