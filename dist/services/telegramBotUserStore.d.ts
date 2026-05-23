interface TelegramUserProfile {
    id: number;
    username?: string;
    first_name?: string;
    last_name?: string;
}
export declare class TelegramBotUserStore {
    private statements;
    markStarted(profile: TelegramUserProfile): void;
    hasStarted(userId: number): boolean;
    getStartedIds(userIds: number[]): Set<number>;
    private getStatements;
}
export declare const telegramBotUserStore: TelegramBotUserStore;
export {};
