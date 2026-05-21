import type { Bot } from '@maxhub/max-bot-api';
import type { Message } from '@maxhub/max-bot-api/types';
import { type Post } from './postStore';
/** Mini App lookup inputs after parsing query + startapp header. */
export interface MiniappPostLookup {
    postId: string;
    chatIdRaw: number | null;
    messageMid: string | null;
}
export declare function postIdsMatch(requested: string, fromPayload: string): boolean;
export declare function extractStartappFromMessage(message: Message): string | null;
/** Channel post `message_mid` (for reply UI stubs — the linked parent post). */
export declare function resolveChannelMessageMid(message: Message): string | null;
/**
 * Orphan Mini App link: `post_id` on the button, no row in SQLite — scan channel feed (slow, once).
 */
export declare function recoverPostByPostIdInChannelFeed(bot: Bot, chatId: number, postId: string): Promise<Post | null>;
/**
 * Resolves a post for Mini App open: alias/DB (fast) → short race retry → ensure by mid → feed scan (slow, once).
 */
export declare function resolveMiniappPostOpen(bot: Bot, lookup: MiniappPostLookup, resolveFromDb: (postId: string, chatIdRaw: number | null, messageMid: string | null) => Post | null): Promise<Post | null>;
