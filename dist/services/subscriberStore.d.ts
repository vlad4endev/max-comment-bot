/**
 * Users who pressed Start in the bot — eligible for DM when a channel replies to their comment.
 */
export declare class SubscriberStore {
    loadFromDisk(): Promise<void>;
    addSubscriber(userId: number): void;
    hasSubscriber(userId: number): boolean;
    removeSubscriber(userId: number): void;
    getAllSubscribers(): number[];
    /** Очистка файла подписчиков (опасная зона в админке). */
    clearAllSubscribers(): void;
    private statements;
    private getStatements;
}
export declare const subscriberStore: SubscriberStore;
