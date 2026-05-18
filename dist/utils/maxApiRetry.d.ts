/** HTTP status from MAX API errors (`err.status` on Error or plain objects). */
export declare function getApiErrorStatus(err: unknown): number | undefined;
/**
 * Retries `fn` on MAX API rate limit (HTTP 429) with exponential backoff.
 */
export declare function apiCallWithRetry<T>(fn: () => Promise<T>, retries?: number): Promise<T>;
/** Alias for {@link apiCallWithRetry} (prompt naming). */
export declare const withRetry: typeof apiCallWithRetry;
