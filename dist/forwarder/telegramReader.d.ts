export declare class TelegramGetUpdatesConflictError extends Error {
    constructor(message: string);
}
export interface TgReplyToMessage {
    message_id: number;
    reply_to_message?: TgReplyToMessage;
    forward_from_message_id?: number;
    is_automatic_forward?: boolean;
    forward_origin?: {
        type?: string;
        chat?: {
            id: number;
        };
        message_id?: number;
    };
    sender_chat?: {
        id: number;
        title?: string;
        username?: string;
    };
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
        type?: string;
    };
    from?: {
        id?: number;
        first_name?: string;
        last_name?: string;
        username?: string;
    };
    reply_to_message?: TgReplyToMessage;
    sender_chat?: {
        id: number;
        title?: string;
        username?: string;
    };
    forward_from_message_id?: number;
    forward_from_chat?: {
        id: number;
    };
    is_automatic_forward?: boolean;
    forward_origin?: {
        type?: string;
        chat?: {
            id: number;
        };
        message_id?: number;
    };
}
export interface TgChannelUpdate {
    update_id: number;
    channel_post?: TgMessage;
    edited_channel_post?: TgMessage;
    edited_message?: TgMessage;
    message?: TgMessage;
    my_chat_member?: Record<string, unknown>;
    callback_query?: Record<string, unknown>;
    raw?: Record<string, unknown>;
}
export declare function getTgUpdates(token: string, offset?: number): Promise<TgMessage[]>;
export declare function getTgFileUrl(token: string, fileId: string): Promise<string | null>;
/** Сырые апдейты с `update_id` — для корректного offset при опросе. */
export declare function getTelegramUpdatesWithIds(token: string, offset: number, timeoutSec?: number, options?: {
    includeMiniappBotUpdates?: boolean;
    includeDiscussionMessages?: boolean;
}): Promise<TgChannelUpdate[]>;
