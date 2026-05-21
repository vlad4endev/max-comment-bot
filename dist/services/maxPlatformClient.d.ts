import type { Bot } from '@maxhub/max-bot-api';
import { type RegisteredChannelAccess } from './channelFullDisconnect';
export interface MaxLinkedChannelInfo {
    id: string;
    title: string;
    type: 'channel' | 'chat' | 'dialog';
    botIsAdmin: boolean;
    access: RegisteredChannelAccess;
    dateAdded: string;
    admins?: Array<{
        user_id: number;
        name: string;
        is_owner: boolean;
    }>;
}
declare function accessLabel(access: RegisteredChannelAccess): string;
/**
 * Каналы MAX из реестра с проверкой через API (getChat, members/me).
 * При `syncRegistry` сначала убирает из реестра чаты, куда бот больше не добавлен.
 */
export declare function listMaxBotLinkedChannels(bot: Bot, options?: {
    syncRegistry?: boolean;
    liveCheck?: boolean;
}): Promise<MaxLinkedChannelInfo[]>;
export declare function maxChannelAccessHint(channels: MaxLinkedChannelInfo[]): string | null;
export { accessLabel as maxChannelAccessLabel };
