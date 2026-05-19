export interface AntispamRules {
    block_links: boolean;
    flood_protection: boolean;
    caps_protection: boolean;
    emoji_spam: boolean;
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
    add_signature: boolean;
    active: boolean;
    created_at: string;
    forwarded_today: number;
    errors_today: number;
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
}
interface StateFile {
    global_stopwords: string[];
    antispam_rules: AntispamRules;
    antispam_log: AntispamLogEntry[];
    channel_extras: Record<string, ChannelAdminExtras>;
    tg_chains: TgChainRecord[];
    autoposts: AutopostRecord[];
}
export declare function getAdminPanelState(): Promise<StateFile>;
export declare function getAntispamWords(): Promise<{
    global: string[];
    byChannel: Record<string, string[]>;
    rules: AntispamRules;
}>;
export declare function saveAntispamWords(input: {
    global?: string[];
    rules?: Partial<AntispamRules>;
}): Promise<void>;
export declare function getAntispamLog(limit: number): Promise<AntispamLogEntry[]>;
export declare function pushAntispamLog(entry: Omit<AntispamLogEntry, 'id' | 'created_at'>): Promise<void>;
export declare function getChannelExtras(chatId: number): Promise<ChannelAdminExtras>;
export declare function saveChannelExtras(chatId: number, patch: Partial<ChannelAdminExtras>): Promise<ChannelAdminExtras>;
export declare function listTgChains(): Promise<TgChainRecord[]>;
export declare function createTgChain(input: Omit<TgChainRecord, 'id' | 'created_at' | 'forwarded_today' | 'errors_today'>): Promise<TgChainRecord>;
export declare function updateTgChain(id: string, patch: Partial<TgChainRecord>): Promise<TgChainRecord | null>;
export declare function deleteTgChain(id: string): Promise<boolean>;
export declare function listAutoposts(): Promise<AutopostRecord[]>;
export declare function createAutopost(input: Omit<AutopostRecord, 'id' | 'created_at' | 'status'>): Promise<AutopostRecord>;
export declare function deleteAutopost(id: string): Promise<boolean>;
export declare function countAntispamBlocksToday(log: AntispamLogEntry[]): number;
/** Удаляет все настройки админки, привязанные к каналу. */
export declare function purgeChannelFromAdminState(chatId: number): Promise<void>;
export {};
