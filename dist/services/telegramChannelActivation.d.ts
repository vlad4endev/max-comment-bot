type TelegramActivationOutcome = {
    status: 'registered';
} | {
    status: 'reconnected';
} | {
    status: 'pending';
    shouldNotifyMissingAdmin: boolean;
};
export declare function tryActivateTelegramChannelRegistration(channelChatId: string, inviterUserId?: number): Promise<TelegramActivationOutcome>;
export declare function runTelegramChannelConnectAttempt(channelChatIds: string[], actorUserId?: number): Promise<string[]>;
export declare function handleTelegramMyChatMemberUpdate(update: Record<string, unknown>): Promise<void>;
export declare function handleTelegramCallbackQuery(update: Record<string, unknown>): Promise<void>;
export declare function handleTelegramPrivateMessage(fromUserId: number, text: string): Promise<void>;
export {};
