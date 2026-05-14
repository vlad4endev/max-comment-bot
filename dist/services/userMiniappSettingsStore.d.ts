export declare const MINIAPP_FEATURE_KEYS: readonly ["comments", "notifications", "moderation", "auto_replies"];
export type MiniappFeatureKey = (typeof MINIAPP_FEATURE_KEYS)[number];
export interface MiniappUserSettings {
    comments: boolean;
    notifications: boolean;
    moderation: boolean;
    auto_replies: boolean;
}
/**
 * JSON-backed per-user Mini App toggles (`data/settings.json`).
 */
export declare class UserMiniappSettingsStore {
    private readonly byUserId;
    private readonly filePath;
    private persistChain;
    constructor(filePath?: string);
    loadFromDisk(): Promise<void>;
    getMerged(userId: number): MiniappUserSettings;
    setFeature(userId: number, feature: MiniappFeatureKey, enabled: boolean): MiniappUserSettings;
    private queuePersist;
    private persist;
}
export declare function parseMiniappFeatureKey(value: unknown): MiniappFeatureKey | null;
export declare const userMiniappSettingsStore: UserMiniappSettingsStore;
