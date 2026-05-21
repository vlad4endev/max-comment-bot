import type { Bot } from '@maxhub/max-bot-api';
import { type Post } from './postStore';
/**
 * Orphan Mini App link: `post_id` on the button, no row in SQLite — scan recent channel feed for matching keyboard.
 */
export declare function recoverPostByPostIdInChannelFeed(bot: Bot, chatId: number, postId: string): Promise<Post | null>;
