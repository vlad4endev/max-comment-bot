import { type OwnerAccountInput, type OwnerPlatform } from './ownerProfileStore';
declare const BOT_USERNAME = "commentvmax_bot";
export interface AccountPairingStatusWire {
    profile_id: string | null;
    max_linked: boolean;
    telegram_linked: boolean;
    max_account: {
        user_id: number;
        username: string | null;
        name: string | null;
    } | null;
    telegram_account: {
        user_id: number;
        username: string | null;
        name: string | null;
    } | null;
}
export interface AccountPairingInviteWire {
    token: string;
    invite_url: string;
    expires_at: string;
    target_platform: 'telegram' | 'max';
}
export declare function getAccountPairingStatus(platform: OwnerPlatform, userId: number): AccountPairingStatusWire;
/** MAX-пользователь приглашает привязать Telegram. */
export declare function createTelegramPairingInvite(account: OwnerAccountInput): AccountPairingInviteWire;
/** Telegram-пользователь приглашает привязать MAX. */
export declare function createMaxPairingInvite(account: OwnerAccountInput): AccountPairingInviteWire;
export declare function completeAccountPairingFromTelegram(startPayload: string, telegramAccount: OwnerAccountInput): {
    profile_id: string;
    max_user_id: number | null;
};
export declare function completeAccountPairingFromMax(startPayload: string, maxAccount: OwnerAccountInput): {
    profile_id: string;
    tg_user_id: number | null;
};
export declare function isAccountPairStartPayload(raw: string): boolean;
export { BOT_USERNAME as TELEGRAM_PAIRING_BOT_USERNAME };
