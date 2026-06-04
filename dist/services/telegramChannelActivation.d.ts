type TelegramActivationOutcome = {
    status: 'registered';
} | {
    status: 'reconnected';
} | {
    status: 'pending';
    shouldNotifyMissingAdmin: boolean;
};
export type TelegramChannelActivationOptions = {
    /** false — только синхронизация статуса без постов/уведомлений (листинг каналов в mini app). */
    notify?: boolean;
    /** Не слать DM этим user id (ответ на /connect или callback уйдёт отдельным сообщением). */
    skipNotifyUserIds?: number[];
};
export declare function clearMissingAdminRightsNotifyDedup(channelChatId: string): void;
export declare function tryActivateTelegramChannelRegistration(channelChatId: string, inviterUserId?: number, options?: TelegramChannelActivationOptions): Promise<TelegramActivationOutcome>;
export declare function runTelegramChannelConnectAttempt(channelChatIds: string[], actorUserId?: number): Promise<string[]>;
export declare function handleTelegramMyChatMemberUpdate(update: Record<string, unknown>): Promise<void>;
/** Повторная проверка прав бота и уведомление при открытии мини-приложения. */
export declare function reconcileTelegramChannelForMiniappUser(channelChatId: string, telegramUserId: number): Promise<void>;
export declare function handleTelegramCallbackQuery(update: Record<string, unknown>): Promise<void>;
export declare function handleTelegramPrivateMessage(fromUserId: number, text: string): Promise<void>;
export {};
