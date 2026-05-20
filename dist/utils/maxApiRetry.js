"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.withRetry = void 0;
exports.getApiErrorStatus = getApiErrorStatus;
exports.isMaxRateLimitError = isMaxRateLimitError;
exports.apiCallWithRetry = apiCallWithRetry;
const logger_1 = require("./logger");
/** HTTP status from MAX API errors (`err.status` on Error or plain objects). */
function getApiErrorStatus(err) {
    if (err instanceof Error) {
        const extra = err;
        if (typeof extra.status === 'number') {
            return extra.status;
        }
        const fromMessage = parseStatusFromMessage(extra.message);
        if (fromMessage !== undefined) {
            return fromMessage;
        }
    }
    if (typeof err === 'object' && err !== null) {
        const o = err;
        if (typeof o.status === 'number') {
            return o.status;
        }
        if (typeof o.message === 'string') {
            const fromMessage = parseStatusFromMessage(o.message);
            if (fromMessage !== undefined) {
                return fromMessage;
            }
        }
    }
    return undefined;
}
function parseStatusFromMessage(message) {
    const m = message.match(/^(\d{3}):/);
    if (!m)
        return undefined;
    const code = Number(m[1]);
    return Number.isFinite(code) ? code : undefined;
}
/** MAX `errors.too-many-chat-messages` and similar send throttling. */
function isMaxRateLimitError(err) {
    if (getApiErrorStatus(err) === 429) {
        return true;
    }
    if (err instanceof Error) {
        return /too-many-chat-messages/i.test(err.message);
    }
    return false;
}
/**
 * Retries `fn` on MAX API rate limit (HTTP 429) with exponential backoff.
 */
async function apiCallWithRetry(fn, retries = 3) {
    let lastErr;
    for (let i = 0; i < retries; i += 1) {
        try {
            return await fn();
        }
        catch (err) {
            lastErr = err;
            if (isMaxRateLimitError(err) && i < retries - 1) {
                const delay = 2 ** i * 1500 + Math.random() * 800;
                logger_1.logger.warn(`MAX API rate limited, retry ${i + 1}/${retries - 1} in ${Math.round(delay)}ms`);
                await new Promise((r) => setTimeout(r, delay));
                continue;
            }
            throw err;
        }
    }
    throw lastErr instanceof Error ? lastErr : new Error('Max retries exceeded');
}
/** Alias for {@link apiCallWithRetry} (prompt naming). */
exports.withRetry = apiCallWithRetry;
//# sourceMappingURL=maxApiRetry.js.map