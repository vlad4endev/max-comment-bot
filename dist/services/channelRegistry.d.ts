import type { ChatType } from '@maxhub/max-bot-api/types';
/**
 * Persisted metadata for a chat where the bot is (or was) present.
 */
export interface ChannelRecord {
    chat_id: number;
    title: string | null;
    type: ChatType;
    /** ISO 8601 timestamp — set when the channel is first registered */
    date_added: string;
}
/**
 * Fields supplied when registering or refreshing a channel (without {@link ChannelRecord.chat_id}).
 */
export interface ChannelSaveInput {
    title: string | null;
    type: ChatType;
}
/**
 * JSON-backed registry of chats the bot participates in.
 * Keeps an in-memory map synchronized with {@link DEFAULT_CHANNELS_PATH}.
 */
export declare class ChannelRegistry {
    private readonly channels;
    private readonly filePath;
    private persistChain;
    constructor(filePath?: string);
    /**
     * Читает `channels.json` и заполняет память. Повторные вызовы перезаписывают кэш.
     */
    loadFromDisk(): Promise<void>;
    /**
     * Сохраняет или обновляет канал. Для уже известного `chat_id` поле {@link ChannelRecord.date_added} не меняется.
     */
    saveChannel(chatId: number, chatData: ChannelSaveInput): void;
    /**
     * Удаляет канал из реестра. Возвращает удалённую запись (для текста уведомления) или `null`, если чата не было.
     */
    removeChannel(chatId: number): ChannelRecord | null;
    /**
     * Возвращает запись по `chat_id` или `null`.
     */
    getChannel(chatId: number): ChannelRecord | null;
    /**
     * Все каналы из текущего реестра, отсортированные по `chat_id`.
     */
    getAllChannels(): ChannelRecord[];
    private queuePersist;
    private persist;
}
export declare const channelRegistry: ChannelRegistry;
