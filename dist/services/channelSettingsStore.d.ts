export interface ChannelSettings {
    manager_url: string | null;
}
/**
 * Per-channel Mini App settings (e.g. manager contact link).
 */
export declare class ChannelSettingsStore {
    private readonly byChatId;
    private readonly filePath;
    private persistChain;
    constructor(filePath?: string);
    loadFromDisk(): Promise<void>;
    getSettings(chatId: number): ChannelSettings;
    getManagerUrl(chatId: number): string | null;
    removeChannel(chatId: number): void;
    setManagerUrl(chatId: number, managerUrl: string | null): ChannelSettings;
    private queuePersist;
    private persist;
}
export declare const channelSettingsStore: ChannelSettingsStore;
export declare function parseManagerUrlInput(value: unknown): string | null | 'invalid';
