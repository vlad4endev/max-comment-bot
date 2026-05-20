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
    /**
     * True when the post row exists but MAX still has no working «Комментарии» button
     * (attach failed). Poller and retry queue keep trying until cleared.
     */
    button_attach_pending?: boolean;
}
export declare class PostStore {
    private statements;
    loadFromDisk(): Promise<void>;
    savePost(post: Post): void;
    /**
     * Ensures a placeholder row exists in `channels` so FK constraint never blocks post save.
     * Real channel data is managed by channelRegistry; this is a safety net only.
     */
    private ensureChannelRow;
    getPost(postId: string): Post | null;
    /**
     * Resolves a post by UUID, compact UUID, `message_mid`, or `chat_id` + `message_mid`.
     */
    findPost(identifier: string, chatId?: number): Post | null;
    findByMessageMid(messageMid: string): Post | null;
    findByCommentsUiMessageMid(commentsUiMid: string): Post | null;
    getPostsByChatId(chatId: number): Post[];
    findPostByChannelMessage(chatId: number, messageMid: string): Post | null;
    /** Reply-stub message id when edit on the original post failed and the bot sent a threaded keyboard. */
    findPostByCommentsUiMessage(chatId: number, commentsUiMid: string): Post | null;
    incrementCommentCount(postId: string): number | null;
    decrementCommentCount(postId: string): number | null;
    removePostsForChatId(chatId: number): string[];
    clearAllPosts(): void;
    getTotalPostCount(): number;
    /**
     * Updates the channel message inline keyboard to show the current comment count.
     */
    updateButtonCaption(bot: Bot, post: Post): Promise<boolean>;
    private parsePost;
    private getStatements;
}
/** MAX rejects edits when attachments exceed this count (observed: 5 photos + keyboard fails). */
export declare const MAX_MESSAGE_ATTACHMENTS = 5;
/** True when original media plus an inline keyboard fit in one {@link Bot.api.editMessage}. */
export declare function canMergeKeyboardWithMedia(mediaCount: number): boolean;
/**
 * Non-keyboard parts of {@link Message.body.attachments} for merging into {@link Bot.api.editMessage}.
 * Incoming {@link Attachment} shapes (e.g. image `payload.url` / `token` / `photo_id`) are accepted by the edit API as {@link AttachmentRequest}.
 */
export declare function mediaAttachmentRequestsFromMessageBody(attachments: Attachment[] | null | undefined): AttachmentRequest[];
/**
 * Option A: {@link Bot.api.editMessage} on the original post (`message_id` + body with `attachments`).
 * Option B (fallback): {@link Bot.api.sendMessageToChat} with `link: { type: 'reply', mid }` — bot-owned message with the keyboard, because channel admins' posts are often not editable by the bot.
 */
export declare function attachCommentButtonToChannelPost(bot: Bot, post: Post, editText: string, keyboard: InlineKeyboardAttachmentRequest, logCtx?: {
    source?: string;
    phase?: string;
}): Promise<boolean>;
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
