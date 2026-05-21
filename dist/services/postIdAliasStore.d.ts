import { type Post } from './postStore';
/**
 * Maps orphan `post_id` from an old button link → canonical row in `posts`.
 * Makes repeat Mini App opens instant after the first successful recovery.
 */
export declare function rememberPostIdAlias(aliasPostId: string, post: Post): void;
export declare function findPostByAlias(aliasPostId: string): Post | null;
