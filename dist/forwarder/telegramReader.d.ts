export declare class TelegramGetUpdatesConflictError extends Error {
    constructor(message: string);
}
export interface TgMessage {
    message_id: number;
    text?: string;
    caption?: string;
    /** Альбом из нескольких фото/видео — отдельные channel_post с одним media_group_id */
    media_group_id?: string;
    photo?: {
        file_id: string;
        file_size: number;
    }[];
    video?: {
        file_id: string;
        mime_type?: string;
    };
    document?: {
        file_id: string;
        mime_type?: string;
        file_name?: string;
    };
    chat: {
        id: number;
        username?: string;
    };
}
export declare function getTgUpdates(token: string, offset?: number): Promise<TgMessage[]>;
export declare function getTgFileUrl(token: string, fileId: string): Promise<string | null>;
/** Сырые апдейты с `update_id` — для корректного offset при опросе. */
export declare function getTelegramUpdatesWithIds(token: string, offset: number, timeoutSec?: number): Promise<Array<{
    update_id: number;
    channel_post: TgMessage;
}>>;
