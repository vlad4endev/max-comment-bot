import type { Bot } from '@maxhub/max-bot-api';
export declare function startPostLinkAutoRecovery(bot: Bot): void;
export declare function stopPostLinkAutoRecovery(): void;
export declare function getPostLinkAutoRecoveryStats(): {
    total_recovered: number;
    total_failed: number;
    today_recovered: number;
    today_failed: number;
    today_key: string;
};
