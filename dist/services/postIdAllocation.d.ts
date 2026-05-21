/** Stable `post_id` for `(chat_id, message_mid)`; reuses row id or a free `preferredPostId` from the button link. */
export declare function allocatePostIdForChannelMessage(chatId: number, messageMid: string, preferredPostId?: string): string;
