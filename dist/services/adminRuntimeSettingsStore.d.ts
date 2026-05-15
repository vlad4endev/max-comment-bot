export declare class AdminRuntimeSettingsStore {
    private pollIntervalMs;
    private readonly filePath;
    constructor(filePath?: string);
    getPollIntervalMs(): number;
    loadFromDisk(): Promise<void>;
    setPollIntervalMs(ms: number): Promise<number>;
    private persist;
}
export declare const adminRuntimeSettingsStore: AdminRuntimeSettingsStore;
