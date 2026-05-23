export interface CommentReply {
    reply_id?: string;
    text: string;
    timestamp: string;
    /** Display name of the admin who replied (from Mini App). */
    admin_name?: string;
    /** Attached image URLs (served by backend). */
    photo_urls?: string[];
}
/** DM to an admin: message id for later edits when the channel replies. */
export interface CommentAdminNotificationMid {
    admin_id: number;
    message_mid: string;
}
/** One channel reply line shown in the admin DM thread (appended on each answer). */
export interface CommentNotificationReplyLogEntry {
    text: string;
    timestamp: string;
    replier_name: string;
    photo_count?: number;
}
/**
 * Persisted comment for a post (Mini App + API).
 */
export interface Comment {
    comment_id: string;
    post_id: string;
    user_id: number;
    username: string;
    text: string;
    timestamp: string;
    /** Author profile photo (MAX `avatar_url` / `full_avatar_url`). */
    avatar_url?: string;
    /** Attached image URLs (served by backend). */
    photo_urls?: string[];
    reply?: CommentReply;
    /** All channel replies in order (miniapp thread); {@link reply} mirrors the latest. */
    replies?: CommentReply[];
    /** Original admin-notification body (before «✅ Отвечено» line is appended). */
    notification_text?: string;
    /** One entry per admin who received the new-comment DM. */
    notification_mids?: CommentAdminNotificationMid[];
    /** Chronology of channel replies appended to the single admin notification. */
    notification_reply_log?: CommentNotificationReplyLogEntry[];
    /** Mini App: admin posted from composer without «Ответить» — show as channel, not personal profile. */
    posted_as_channel?: boolean;
}
export declare function replyToNotificationLogEntry(reply: CommentReply, notificationReplierName?: string): CommentNotificationReplyLogEntry;
export interface AdminCommentListRow {
    comment: Comment;
    post_preview: string;
}
export declare class CommentStore {
    private statements;
    loadFromDisk(): Promise<void>;
    saveComment(input: Omit<Comment, 'comment_id' | 'timestamp'>): Comment;
    getComments(postId: string): Comment[];
    /**
     * Attaches a channel reply to a comment. Returns updated comment or `null`.
     * @param replyAdminName optional display name of the replying admin (non-empty trimmed string is stored).
     */
    addReply(commentId: string, replyText: string, replyAdminName?: string, replyPhotoUrls?: string[], notificationReplierName?: string): Comment | null;
    /**
     * Updates comment body text. Returns updated comment or `null`.
     */
    updateCommentText(commentId: string, text: string): Comment | null;
    /** Persists author avatar URL when resolved from MAX API or Mini App. */
    setCommentAvatarUrl(commentId: string, avatarUrl: string): Comment | null;
    /**
     * Updates an existing admin reply (preserves original timestamp). Returns `null` if missing.
     * @param replyPhotoUrls `undefined` — не менять вложения; `[]` — удалить фото; иначе заменить список URL.
     */
    updateReply(commentId: string, replyText: string, replyAdminName?: string, replyPhotoUrls?: string[]): Comment | null;
    /**
     * Removes the admin reply from a comment. Returns updated comment or `null`.
     */
    deleteReply(commentId: string): Comment | null;
    /**
     * Deletes a comment entirely. Returns removed comment or `null`.
     */
    deleteComment(commentId: string): Comment | null;
    /**
     * Returns a single comment or `null`.
     */
    getComment(commentId: string): Comment | null;
    /**
     * Persists the admin DM template text for this comment (used when editing notifications after reply).
     */
    saveNotificationText(commentId: string, text: string): void;
    /**
     * Records the DM `message_mid` for one admin (upserts by `admin_id`).
     */
    saveNotificationMid(commentId: string, adminId: number, mid: string): void;
    getNotificationMids(commentId: string): CommentAdminNotificationMid[];
    /**
     * Counts comments whose posts belong to the given channel (`postIds` from postStore).
     */
    countForPostIds(postIds: Set<string>): number;
    /**
     * All comments, newest first (admin list).
     */
    listAllCommentsNewestFirst(): Comment[];
    /**
     * Comments for posts in a channel (SQL join — без загрузки всех комментариев).
     */
    listCommentsForChannelChatId(chatId: number, limit?: number): Comment[];
    /**
     * Пагинированный список комментариев канала для админки (JOIN с posts, без N+1).
     */
    listCommentsForChannelAdminPage(chatId: number, options?: {
        limit?: number;
        q?: string;
    }): AdminCommentListRow[];
    /** Агрегаты комментариев по user_id для списка пользователей в админке. */
    aggregateUserCommentStats(): Map<number, {
        total: number;
        answered: number;
        unanswered: number;
        last_comment_at: string | null;
        latest_username: string | null;
        latest_avatar_url: string | null;
    }>;
    countCommentsByChatId(chatId: number): number;
    removeCommentsByPostIds(postIds: Set<string>): number;
    /** Очистка comments.json (опасная зона / сброс постов). */
    clearAllComments(): void;
    /**
     * Total comment count.
     */
    get totalCount(): number;
    private parseRow;
    private saveRow;
    private getStatements;
}
export declare const commentStore: CommentStore;
