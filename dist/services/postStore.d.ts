import type { Bot } from '@maxhub/max-bot-api';
import type { Attachment, AttachmentRequest, InlineKeyboardAttachmentRequest } from '@maxhub/max-bot-api/types';
/**
 * Channel post tracked for Mini App comments (MAX message id is {@link Post.message_mid}).
 */
export interface Post {
    post_id: string;
    chat_id: number;
    message_mid: string;
    /** If {@link attachCommentButtonToChannelPost} falls back to a reply, edits/updates target this bot message id. */
    comments_ui_message_mid?: string;
    /** Display name of the post author, or a placeholder for channel-as-author posts. */
    sender_name?: string;
    text: string;
    photo_url?: string;
    /** Public MAX link to the channel post (`Message.url` from API). */
    channel_post_url?: string;
    /**
     * Non-keyboard attachments from the channel post (from {@link Message.body.attachments}).
     * Used so {@link Bot.api.editMessage} can merge media with the inline keyboard instead of replacing all attachments.
     */
    media_attachments?: AttachmentRequest[];
    comment_count: number;
    timestamp: string;
}
export declare class PostStore {
    private statements;
    loadFromDisk(): Promise<void>;
    savePost(post: Post): void;
    getPost(postId: string): Post | null;
    getPostsByChatId(chatId: number): Post[];
    findPostByChannelMessage(chatId: number, messageMid: string): Post | null;
    incrementCommentCount(postId: string): number | null;
    decrementCommentCount(postId: string): number | null;
    removePostsForChatId(chatId: number): string[];
    clearAllPosts(): void;
    getTotalPostCount(): number;
    /**
     * Updates the channel message inline keyboard to show the current comment count.
     */
    updateButtonCaption(bot: Bot, post: Post): Promise<void>;
    private parsePost;
    private getStatements;
}
/**
 * Non-keyboard parts of {@link Message.body.attachments} for merging into {@link Bot.api.editMessage}.
 * Incoming {@link Attachment} shapes (e.g. image `payload.url` / `token` / `photo_id`) are accepted by the edit API as {@link AttachmentRequest}.
 */
export declare function mediaAttachmentRequestsFromMessageBody(attachments: Attachment[] | null | undefined): AttachmentRequest[];
/**
 * Option A: {@link Bot.api.editMessage} on the original post (`message_id` + body with `attachments`).
 * Option B (fallback): {@link Bot.api.sendMessageToChat} with `link: { type: 'reply', mid }` — bot-owned message with the keyboard, because channel admins' posts are often not editable by the bot.
 */
export declare function attachCommentButtonToChannelPost(bot: Bot, post: Post, editText: string, keyboard: InlineKeyboardAttachmentRequest): Promise<void>;
/** True if we can build a link that opens the Mini App (MAX deep link or legacy MINI_APP_URL). */
export declare function isMiniAppOpenUrlConfigured(): boolean;
/**
 * MAX Mini App: `https://max.ru/<bot>?startapp=<payload>` (payload: A–Z, a–z, 0–9, _, -).
 * Fallback: legacy {@link config.miniAppUrl} with `post_id` / `chat_id` query params.
 */
/** Returns shareable channel post URL; fetches from MAX API and persists when missing in DB. */
export declare function resolveChannelPostUrl(bot: Bot, post: Post): Promise<string | null>;
export declare function buildMiniAppUrl(postId: string, chatId: number, extra?: Record<string, string>, messageMid?: string): string;
export declare const postStore: PostStore;
