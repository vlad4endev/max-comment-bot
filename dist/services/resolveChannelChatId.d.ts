/**
 * Resolves `join{digits}`, a signed chat id, or an abs id string to the canonical channel `chat_id`
 * stored in {@link channelRegistry} (needed when invite links use `Math.abs(chat_id)` only).
 */
export declare function resolveChannelChatIdFromInviteParam(raw: string): number | null;
/** Canonical negative `chat_id` from registry (matches invite links that only carry `abs(id)`). */
export declare function resolveCanonicalChannelChatId(chatId: number): number | null;
