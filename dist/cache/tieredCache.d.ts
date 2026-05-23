export declare function cacheGetJson<T>(key: string): Promise<T | null>;
export declare function cacheSetJson(key: string, value: unknown, ttlSec: number): Promise<void>;
export declare function cacheGetOrCompute<T>(key: string, ttlSec: number, compute: () => Promise<T>): Promise<T>;
/**
 * Distributed lock / dedup: returns true if lock acquired (SET NX EX).
 * Falls back to in-process memory when Redis is unavailable.
 */
export declare function cacheTryAcquireLock(lockKey: string, ttlSec: number): Promise<boolean>;
export declare function cacheDelete(key: string): Promise<void>;
