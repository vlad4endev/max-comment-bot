import type { Bot } from '@maxhub/max-bot-api';
import type { ChatMember } from '@maxhub/max-bot-api/types';
export declare function extractMemberAvatarUrl(member: Pick<ChatMember, 'avatar_url' | 'full_avatar_url'> | undefined): string | null;
/**
 * Resolves profile photo URLs for users via channel membership, then private dialog fallback.
 */
export declare function resolveMemberAvatarUrls(bot: Bot, channelChatId: number, userIds: number[]): Promise<Map<number, string>>;
/**
 * Display name for a user (e.g. who replied as channel): `name` from channel membership,
 * then from remembered private dialog with the bot.
 */
export declare function resolveMemberDisplayName(bot: Bot, channelChatId: number, userId: number): Promise<string | null>;
