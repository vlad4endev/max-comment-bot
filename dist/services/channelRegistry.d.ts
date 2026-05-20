import type { ChatType } from '@maxhub/max-bot-api/types';
/** Регистрирует колбэк (поллер каналов) без циклического import. */
export declare function setChannelRegistryChangeHandler(handler: (() => void) | null): void;
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
export declare class ChannelRegistry {
    private statements;
    loadFromDisk(): Promise<void>;
    /**
     * Сохраняет или обновляет канал. Для уже известного `chat_id` поле {@link ChannelRecord.date_added} не меняется.
     */
    saveChannel(chatId: number, chatData: ChannelSaveInput): void;
    /**
     * Исключает канал из поллера и реестра без удаления постов/комментариев (повторные ошибки API).
     */
    deactivate(chatId: number): ChannelRecord | null;
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
    private parseRow;
    private getStatements;
}
export declare const channelRegistry: ChannelRegistry;
