export type LogAiProvider = 'openrouter' | 'openai' | 'custom';
export interface LogAiConfigFile {
    provider: LogAiProvider;
    api_key: string;
    base_url: string;
    model: string;
    updated_at: string;
}
declare class LogAiSettingsStore {
    private config;
    loadFromDisk(): Promise<void>;
    getConfig(): LogAiConfigFile | null;
    getApiKeyPreview(): string;
    isConfigured(): boolean;
    save(patch: {
        provider?: LogAiProvider;
        api_key?: string;
        base_url?: string;
        model?: string;
    }): Promise<LogAiConfigFile>;
    private persist;
}
export declare const logAiSettingsStore: LogAiSettingsStore;
export {};
