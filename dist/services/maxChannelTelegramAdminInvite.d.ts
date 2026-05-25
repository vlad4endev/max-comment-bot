/** Numeric Telegram chat id linked to this MAX channel (tg_chain or integration flow). */
export declare function resolvePrimaryTelegramChannelChatIdForMax(maxChatId: number): string | null;
/** `jointg…` deep link for TG-only admins of the linked Telegram channel. */
export declare function buildTelegramNotifyInviteUrlForMaxChannel(maxChatId: number): string | null;
export interface SupplementalTelegramAdminWire {
    user_id: number;
    name: string;
    initials: string;
    linked: boolean;
    paired: boolean;
    max_user_id: null;
    tg_user_id: number;
    peer_platform: 'telegram';
    admin_platform: 'telegram';
}
/**
 * TG channel admins who are not represented as MAX channel admins (colleagues only in Telegram).
 */
export declare function listSupplementalTelegramAdminsForMaxChannel(maxChatId: number, maxAdminUserIds: Set<number>, tgToken: string): Promise<{
    tgChannelChatId: string | null;
    admins: SupplementalTelegramAdminWire[];
}>;
