/**
 * Users who pressed Start in the bot — eligible for DM when a channel replies to their comment.
 */
export declare class SubscriberStore {
    private readonly subscribers;
    private readonly filePath;
    private persistChain;
    constructor(filePath?: string);
    loadFromDisk(): Promise<void>;
    addSubscriber(userId: number): void;
    hasSubscriber(userId: number): boolean;
    removeSubscriber(userId: number): void;
    getAllSubscribers(): number[];
    private queuePersist;
    private persist;
}
export declare const subscriberStore: SubscriberStore;
