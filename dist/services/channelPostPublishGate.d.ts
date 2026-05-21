import type { Bot } from '@maxhub/max-bot-api';
import { type Post } from './postStore';
/** Post row exists, ids align, startapp has `_mid_`, button attach is not pending. */
export declare function verifyPostCommentButtonReady(post: Post): boolean;
/** Removes MAX message(s) and DB row after a failed comment gate. */
export declare function rollbackFailedChannelPost(bot: Bot, chatId: number, messageMid: string, postId: string, post?: Post | null): Promise<void>;
/**
 * After TG→MAX forward: save post with fixed `post_id`, attach button, verify Mini App lookup.
 * On failure deletes the MAX post and DB row so the TG message can be forwarded again.
 */
export declare function attachAndVerifyCommentsForForwardedPost(bot: Bot, maxChatId: number, maxMessageMid: string, context?: {
    chainId?: string;
}): Promise<boolean>;
