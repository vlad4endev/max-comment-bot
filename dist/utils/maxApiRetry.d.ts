/** HTTP status from MAX API errors (`err.status` on Error or plain objects). */
export declare function getApiErrorStatus(err: unknown): number | undefined;
/** MAX `errors.too-many-chat-messages` and similar send throttling. */
export declare function isMaxRateLimitError(err: unknown): boolean;
/** Transient server-side errors that are safe to retry (5xx, network issues). */
export declare function isMaxTransientError(err: unknown): boolean;
/**
 * Retries `fn` on MAX API rate limit (HTTP 429) or transient errors with exponential backoff.
 * Default 5 retries for attach operations (large channels hit 429 often).
 */
export declare function apiCallWithRetry<T>(fn: () => Promise<T>, retries?: number): Promise<T>;
/** Alias for {@link apiCallWithRetry} (prompt naming). */
export declare const withRetry: typeof apiCallWithRetry;
