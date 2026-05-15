/**
 * Stores user ids explicitly disabled from bot admin capabilities.
 */
export declare class DisabledAdminStore {
    private readonly disabledUserIds;
    private readonly filePath;
    private persistChain;
    constructor(filePath?: string);
    loadFromDisk(): Promise<void>;
    isDisabled(userId: number): boolean;
    disableUser(userId: number): void;
    private queuePersist;
    private persist;
}
export declare const disabledAdminStore: DisabledAdminStore;
