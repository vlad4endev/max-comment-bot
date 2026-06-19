import type { ScoredWordsByScore } from '../db/seedAntispamScoredWords';
import type { AntispamEngineConfig, AntispamLogEntry, AntispamRules } from '../api/adminPanelState';
export interface ChannelAntispamSettings {
    stopwords: string[];
    block_links: boolean | null;
    flood_protection: boolean | null;
    auto_mute: boolean;
}
export declare function ensureAntispamStoreLoaded(): void;
export declare function reloadAntispamStore(): void;
export declare function getAntispamEngineSync(): AntispamEngineConfig;
export declare function getAntispamRulesSync(): AntispamRules;
export declare function getGlobalStopwordsSync(): string[];
export declare function getScoredWordsSync(): ScoredWordsByScore;
export declare function countScoredWordsSync(): number;
export declare function saveScoredWordsToStore(dict: ScoredWordsByScore): ScoredWordsByScore;
export declare function getChannelAntispamSettingsSync(chatId: number): ChannelAntispamSettings;
export declare function isAntispamRestrictedUserSync(userId: number): boolean;
export declare function getAntispamWordsSnapshot(): {
    global: string[];
    byChannel: Record<string, string[]>;
    rules: AntispamRules;
    engine: AntispamEngineConfig;
    restricted_users: number[];
    scored_words: ScoredWordsByScore;
    scored_words_total: number;
};
export declare function saveAntispamEngineToStore(patch: Partial<AntispamEngineConfig>): AntispamEngineConfig;
export declare function saveAntispamWordsToStore(input: {
    global?: string[];
    rules?: Partial<AntispamRules>;
}): void;
export declare function saveChannelAntispamSettings(chatId: number, patch: Partial<ChannelAntispamSettings>): ChannelAntispamSettings;
export declare function restrictAntispamUserInStore(userId: number): void;
export declare function pushAntispamLogToStore(entry: Omit<AntispamLogEntry, 'id' | 'created_at'>): AntispamLogEntry;
export declare function listAntispamLogFromStore(limit: number): AntispamLogEntry[];
export declare function purgeAntispamChannelData(chatId: number): void;
export declare function countAntispamBlocksTodayFromStore(): number;
