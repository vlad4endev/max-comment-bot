import type { Bot } from '@maxhub/max-bot-api';
import type { ChatMember } from '@maxhub/max-bot-api/types';
export declare function extractMemberAvatarUrl(member: Pick<ChatMember, 'avatar_url' | 'full_avatar_url'> | undefined): string | null;
/**
 * Resolves profile photo URLs for users via channel membership, then private dialog fallback.
 */
export declare function resolveMemberAvatarUrls(bot: Bot, channelChatId: number, userIds: number[]): Promise<Map<number, string>>;
