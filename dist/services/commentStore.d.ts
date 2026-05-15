export interface CommentReply {
    text: string;
    timestamp: string;
    /** Display name of the admin who replied (from Mini App). */
    admin_name?: string;
}
/** DM to an admin: message id for later edits when the channel replies. */
export interface CommentAdminNotificationMid {
    admin_id: number;
    message_mid: string;
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
    reply?: CommentReply;
    /** Original admin-notification body (before «✅ Отвечено» line is appended). */
    notification_text?: string;
    /** One entry per admin who received the new-comment DM. */
    notification_mids?: CommentAdminNotificationMid[];
}
/**
 * JSON-backed comment list with async persistence under `data/comments.json`.
 */
export declare class CommentStore {
    private readonly comments;
    private readonly filePath;
    private persistChain;
    constructor(filePath?: string);
    /**
     * Loads comments from disk (replaces in-memory list).
     */
    loadFromDisk(): Promise<void>;
    /**
     * Appends a new comment (assigns id and ISO timestamp) and persists.
     */
    saveComment(input: Omit<Comment, 'comment_id' | 'timestamp'>): Comment;
    /**
     * Returns comments for a post, oldest first.
     */
    getComments(postId: string): Comment[];
    /**
     * Attaches a channel reply to a comment. Returns updated comment or `null`.
     * @param replyAdminName optional display name of the replying admin (non-empty trimmed string is stored).
     */
    addReply(commentId: string, replyText: string, replyAdminName?: string): Comment | null;
    /**
     * Updates comment body text. Returns updated comment or `null`.
     */
    updateCommentText(commentId: string, text: string): Comment | null;
    /**
     * Updates an existing admin reply (preserves original timestamp). Returns `null` if missing.
     */
    updateReply(commentId: string, replyText: string, replyAdminName?: string): Comment | null;
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
     * Comments for posts in a channel (`postStore` lookup).
     */
    listCommentsForChannelChatId(chatId: number): Comment[];
    removeCommentsByPostIds(postIds: Set<string>): number;
    /** Очистка comments.json (опасная зона / сброс постов). */
    clearAllComments(): void;
    /**
     * Total comment count.
     */
    get totalCount(): number;
    private queuePersist;
    private persist;
}
export declare const commentStore: CommentStore;
