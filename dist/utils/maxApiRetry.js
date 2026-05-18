"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.withRetry = void 0;
exports.getApiErrorStatus = getApiErrorStatus;
exports.apiCallWithRetry = apiCallWithRetry;
const logger_1 = require("./logger");
/** HTTP status from MAX API errors (`err.status` on Error or plain objects). */
function getApiErrorStatus(err) {
    if (err instanceof Error) {
        const extra = err;
        if (typeof extra.status === 'number') {
            return extra.status;
        }
    }
    if (typeof err === 'object' && err !== null) {
        const o = err;
        if (typeof o.status === 'number') {
            return o.status;
        }
    }
    return undefined;
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
            if (getApiErrorStatus(err) === 429 && i < retries - 1) {
                const delay = 2 ** i * 1000 + Math.random() * 500;
                logger_1.logger.warn(`MAX API rate limited, retry ${i + 1} in ${Math.round(delay)}ms`);
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