"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getRedisUrl = getRedisUrl;
exports.isRedisConfigured = isRedisConfigured;
exports.initRedis = initRedis;
exports.getRedisClient = getRedisClient;
exports.pingRedis = pingRedis;
exports.disconnectRedis = disconnectRedis;
const ioredis_1 = __importDefault(require("ioredis"));
const logger_1 = require("../utils/logger");
let client = null;
let initAttempted = false;
function getRedisUrl() {
    const url = (process.env.REDIS_URL ?? '').trim();
    return url !== '' ? url : null;
}
function isRedisConfigured() {
    return getRedisUrl() !== null;
}
async function initRedis() {
    const url = getRedisUrl();
    if (!url) {
        logger_1.logger.info('redis: REDIS_URL not set — in-memory cache only');
        return 'disabled';
    }
    if (client && client.status === 'ready') {
        return 'connected';
    }
    const maxAttempts = 5;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (initAttempted && !client) {
            initAttempted = false;
        }
        const status = await connectOnce(url);
        if (status === 'connected' || status === 'disabled') {
            return status;
        }
        if (attempt < maxAttempts) {
            await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
    }
    return 'unavailable';
}
async function connectOnce(url) {
    if (client && client.status === 'ready') {
        return 'connected';
    }
    if (initAttempted && !client) {
        return 'unavailable';
    }
    initAttempted = true;
    try {
        const redis = new ioredis_1.default(url, {
            maxRetriesPerRequest: 1,
            connectTimeout: 5_000,
            commandTimeout: 3_000,
            lazyConnect: true,
            retryStrategy: (times) => (times > 4 ? null : Math.min(times * 200, 2_000)),
        });
        redis.on('error', (err) => {
            logger_1.logger.warn('redis: client error', { err: String(err) });
        });
        await redis.connect();
        client = redis;
        logger_1.logger.info('redis: connected');
        return 'connected';
    }
    catch (err) {
        logger_1.logger.warn('redis: connect failed — in-memory cache only', { err: String(err) });
        try {
            await client?.quit();
        }
        catch {
            // ignore
        }
        client = null;
        initAttempted = true;
        return 'unavailable';
    }
}
function getRedisClient() {
    if (!client || client.status !== 'ready') {
        return null;
    }
    return client;
}
async function pingRedis() {
    const redis = getRedisClient();
    if (!redis) {
        return false;
    }
    try {
        return (await redis.ping()) === 'PONG';
    }
    catch {
        return false;
    }
}
async function disconnectRedis() {
    if (!client) {
        return;
    }
    try {
        await client.quit();
    }
    catch (err) {
        logger_1.logger.warn('redis: quit error', { err: String(err) });
    }
    finally {
        client = null;
    }
}
//# sourceMappingURL=redisClient.js.map