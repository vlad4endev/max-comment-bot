/** Telegram-style monotonic post id (decimal string, unique in `posts`). */
export declare function allocatePostId(): string;
/** Segment after `pid_` in MAX startapp: decimal id or 32-char UUID hex. */
export declare function parsePostIdFromStartappSegment(segment: string): string | null;
/** Encodes `post_id` for `pid_<…>_cid_…` (numeric as-is, UUID without dashes). */
export declare function formatPostIdForStartapp(postId: string): string;
export declare function isNumericPostId(postId: string): boolean;
