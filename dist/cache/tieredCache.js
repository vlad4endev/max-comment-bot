"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cacheGetJson = cacheGetJson;
exports.cacheSetJson = cacheSetJson;
exports.cacheGetOrCompute = cacheGetOrCompute;
exports.cacheTryAcquireLock = cacheTryAcquireLock;
exports.cacheDelete = cacheDelete;
const redisClient_1 = require("./redisClient");
const logger_1 = require("../utils/logger");
const memory = new Map();
function memoryGet(key) {
    const entry = memory.get(key);
    if (!entry) {
        return null;
    }
    if (Date.now() >= entry.expiresAt) {
        memory.delete(key);
        return null;
    }
    return entry.value;
}
function memorySet(key, value, ttlSec) {
    memory.set(key, {
        value,
        expiresAt: Date.now() + ttlSec * 1000,
    });
    if (memory.size > 5_000) {
        pruneMemory();
    }
}
function pruneMemory() {
    const now = Date.now();
    for (const [key, entry] of memory) {
        if (now >= entry.expiresAt) {
            memory.delete(key);
        }
    }
}
function prefixKey(key) {
    return `mc:${key}`;
}
async function cacheGetJson(key) {
    const fullKey = prefixKey(key);
    const local = memoryGet(fullKey);
    if (local !== null) {
        try {
            return JSON.parse(local);
        }
        catch {
            memory.delete(fullKey);
        }
    }
    const redis = (0, redisClient_1.getRedisClient)();
    if (!redis) {
        return null;
    }
    try {
        const raw = await redis.get(fullKey);
        if (raw === null) {
            return null;
        }
        memorySet(fullKey, raw, 60);
        return JSON.parse(raw);
    }
    catch (err) {
        logger_1.logger.warn('tieredCache: redis GET failed', { key, err: String(err) });
        return null;
    }
}
async function cacheSetJson(key, value, ttlSec) {
    const fullKey = prefixKey(key);
    const serialized = JSON.stringify(value);
    memorySet(fullKey, serialized, ttlSec);
    const redis = (0, redisClient_1.getRedisClient)();
    if (!redis) {
        return;
    }
    try {
        await redis.set(fullKey, serialized, 'EX', Math.max(1, ttlSec));
    }
    catch (err) {
        logger_1.logger.warn('tieredCache: redis SET failed', { key, err: String(err) });
    }
}
async function cacheGetOrCompute(key, ttlSec, compute) {
    const cached = await cacheGetJson(key);
    if (cached !== null) {
        return cached;
    }
    const value = await compute();
    await cacheSetJson(key, value, ttlSec);
    return value;
}
/**
 * Distributed lock / dedup: returns true if lock acquired (SET NX EX).
 * Falls back to in-process memory when Redis is unavailable.
 */
async function cacheTryAcquireLock(lockKey, ttlSec) {
    const fullKey = prefixKey(`lock:${lockKey}`);
    const redis = (0, redisClient_1.getRedisClient)();
    if (redis) {
        try {
            const result = await redis.set(fullKey, '1', 'EX', Math.max(1, ttlSec), 'NX');
            if (result === 'OK') {
                return true;
            }
            return false;
        }
        catch (err) {
            logger_1.logger.warn('tieredCache: redis lock failed', { lockKey, err: String(err) });
        }
    }
    const existing = memoryGet(fullKey);
    if (existing !== null) {
        return false;
    }
    memorySet(fullKey, '1', ttlSec);
    return true;
}
async function cacheDelete(key) {
    const fullKey = prefixKey(key);
    memory.delete(fullKey);
    const redis = (0, redisClient_1.getRedisClient)();
    if (!redis) {
        return;
    }
    try {
        await redis.del(fullKey);
    }
    catch (err) {
        logger_1.logger.warn('tieredCache: redis DEL failed', { key, err: String(err) });
    }
}
//# sourceMappingURL=tieredCache.js.map