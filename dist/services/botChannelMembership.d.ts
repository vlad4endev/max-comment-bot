import type { Bot } from '@maxhub/max-bot-api';
import type { ChatMember } from '@maxhub/max-bot-api/types';
/**
 * Loads the bot's own {@link ChatMember} row in a chat via `GET chats/{id}/members/me`.
 */
export declare function fetchBotChatMember(bot: Bot, channelChatId: number): Promise<ChatMember | null>;
/** Whether the bot is allowed to moderate the channel (admin or owner). */
export declare function isBotAdminOrOwner(member: ChatMember): boolean;
