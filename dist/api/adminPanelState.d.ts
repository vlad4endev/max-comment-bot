export interface AntispamRules {
    block_links: boolean;
    flood_protection: boolean;
    caps_protection: boolean;
    emoji_spam: boolean;
}
/** Параметры скорингового движка (порт antispam_v16 из n8n). */
export interface AntispamEngineConfig {
    /** true = только журнал, комментарии не блокируются */
    soft_mode: boolean;
    enabled: boolean;
    spam_threshold: number;
    ban_threshold: number;
    captcha_required_score: number;
    emoji_overuse_limit: number;
    whitelist_user_ids: number[];
    blacklist_user_ids: number[];
}
export interface ChannelAdminExtras {
    button_text: string;
    welcome_message: string;
    notify_admin: boolean;
    show_reactions: boolean;
    moderation_mode: boolean;
    stopwords: string[];
    block_links: boolean;
    flood_protection: boolean;
    auto_mute: boolean;
}
export interface VkChainRecord {
    id: string;
    /** ID канала MAX, с которым связана VK-группа. */
    max_chat_id: number;
    max_title: string | null;
    /** ID сообщества VK (без минуса, например "12345678"). */
    vk_group_id: string;
    /** Токен сообщества VK с правами wall и comments. */
    vk_token: string;
    /** Пересылать посты из MAX → VK (вызывается хуком из tgChainForwarder). */
    forward_posts: boolean;
    /** Синхронизировать комментарии VK ↔ MAX miniapp. */
    sync_comments: boolean;
    active: boolean;
    created_at: string;
    forwarded_today: number;
    errors_today: number;
}
export interface TgChainRecord {
    id: string;
    max_chat_id: number;
    max_title: string | null;
    tg_username: string;
    /** Числовой ID TG-канала (-100…), если выбран из списка интеграции */
    tg_channel_id?: string;
    bot_token: string;
    forward_posts: boolean;
    forward_comments: boolean;
    /** Явный ID чата обсуждений TG (-100…); если пусто — linked_chat_id канала. */
    tg_discussion_chat_id?: string | null;
    /** От чьего имени публиковать ответы MAX → TG: канал или группа обсуждений (аноним). */
    tg_discussion_send_as?: 'channel' | 'chat';
    /** Ключевые слова/фразы: обычные комментарии TG синхронизируются только при совпадении. */
    comment_sync_keywords?: string[];
    /** Режим сопоставления слов: contains | equals | word | starts_with | ends_with. */
    comment_sync_match_mode?: 'contains' | 'equals' | 'word' | 'starts_with' | 'ends_with';
    /** Кнопка «Комментарии» под постом в MAX после пересылки */
    add_comments_button: boolean;
    add_signature: boolean;
    active: boolean;
    /** ISO-время автопаузы (бот потерял админ-права в TG); снимается при восстановлении. */
    auto_paused_at?: string | null;
    created_at: string;
    forwarded_today: number;
    errors_today: number;
    /** Профиль владельца (MAX + Telegram) в SQLite */
    owner_profile_id?: string;
    created_via?: 'admin' | 'miniapp_link';
    max_user_id?: number;
    tg_user_id?: number;
}
export interface AutopostRecord {
    id: string;
    chat_id: number;
    channel_title: string | null;
    text: string;
    scheduled_at: string;
    repeat: 'none' | 'daily' | 'weekly' | 'monthly';
    status: 'scheduled' | 'sent' | 'failed';
    created_at: string;
}
export interface AntispamLogEntry {
    id: string;
    user_id: number;
    username: string | null;
    channel_chat_id: number;
    channel_title: string | null;
    reason: string;
    text: string;
    created_at: string;
    spam_score?: number;
    action?: string;
    source?: string;
    categories?: string[];
}
interface StateFile {
    global_stopwords: string[];
    antispam_rules: AntispamRules;
    antispam_engine: AntispamEngineConfig;
    /** Пользователи, заблокированные антиспамом (auto_mute / ban). */
    antispam_restricted_users: number[];
    antispam_log: AntispamLogEntry[];
    channel_extras: Record<string, ChannelAdminExtras>;
    tg_chains: TgChainRecord[];
    vk_chains: VkChainRecord[];
    autoposts: AutopostRecord[];
}
export declare function getAdminPanelState(): Promise<StateFile>;
export declare function getAntispamWords(): Promise<{
    global: string[];
    byChannel: Record<string, string[]>;
    rules: AntispamRules;
    engine: AntispamEngineConfig;
    restricted_users: number[];
    scored_words: import('../db/seedAntispamScoredWords').ScoredWordsByScore;
    scored_words_total: number;
}>;
export declare function getAntispamEngineSync(): AntispamEngineConfig;
export declare function getAntispamRulesSync(): AntispamRules;
export declare function getGlobalStopwordsSync(): string[];
export declare function getScoredWordsSync(): import('../db/seedAntispamScoredWords').ScoredWordsByScore;
export declare function saveScoredWords(dict: import('../db/seedAntispamScoredWords').ScoredWordsByScore): Promise<import('../db/seedAntispamScoredWords').ScoredWordsByScore>;
export declare function getChannelExtrasSync(chatId: number): ChannelAdminExtras;
export declare function isAntispamRestrictedUserSync(userId: number): boolean;
export declare function saveAntispamEngine(patch: Partial<AntispamEngineConfig>): Promise<AntispamEngineConfig>;
export declare function restrictAntispamUser(userId: number): Promise<void>;
export declare function saveAntispamWords(input: {
    global?: string[];
    rules?: Partial<AntispamRules>;
}): Promise<void>;
export declare function getAntispamLog(limit: number): Promise<AntispamLogEntry[]>;
export declare function pushAntispamLog(entry: Omit<AntispamLogEntry, 'id' | 'created_at'>): Promise<void>;
export declare function getChannelExtras(chatId: number): Promise<ChannelAdminExtras>;
export declare function saveChannelExtras(chatId: number, patch: Partial<ChannelAdminExtras>): Promise<ChannelAdminExtras>;
export declare function listTgChains(): Promise<TgChainRecord[]>;
/** In-memory snapshot for hot paths (poller, webhook); call {@link ensureAdminPanelStateLoaded} at startup. */
export declare function listTgChainsSync(): TgChainRecord[];
export declare function ensureAdminPanelStateLoaded(): Promise<void>;
export declare function createTgChain(input: Omit<TgChainRecord, 'id' | 'created_at' | 'forwarded_today' | 'errors_today'>): Promise<TgChainRecord>;
export declare function updateTgChain(id: string, patch: Partial<TgChainRecord>): Promise<TgChainRecord | null>;
export declare function deleteTgChain(id: string): Promise<boolean>;
export declare function listVkChains(): Promise<VkChainRecord[]>;
/** Synchronous snapshot for hot paths — call {@link ensureAdminPanelStateLoaded} at startup. */
export declare function listVkChainsSync(): VkChainRecord[];
export declare function createVkChain(input: Omit<VkChainRecord, 'id' | 'created_at' | 'forwarded_today' | 'errors_today'>): Promise<VkChainRecord>;
export declare function updateVkChain(id: string, patch: Partial<VkChainRecord>): Promise<VkChainRecord | null>;
export declare function deleteVkChain(id: string): Promise<boolean>;
export declare function listAutoposts(): Promise<AutopostRecord[]>;
export declare function createAutopost(input: Omit<AutopostRecord, 'id' | 'created_at' | 'status'>): Promise<AutopostRecord>;
export declare function deleteAutopost(id: string): Promise<boolean>;
export declare function countAntispamBlocksToday(_log?: AntispamLogEntry[]): number;
/** Удаляет все настройки админки, привязанные к каналу. */
export declare function purgeChannelFromAdminState(chatId: number): Promise<void>;
export {};
