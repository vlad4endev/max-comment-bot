export interface CommentReply {
    text: string;
    timestamp: string;
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
     */
    addReply(commentId: string, replyText: string): Comment | null;
    /**
     * Returns a single comment or `null`.
     */
    getComment(commentId: string): Comment | null;
    /**
     * Counts comments whose posts belong to the given channel (`postIds` from postStore).
     */
    countForPostIds(postIds: Set<string>): number;
    private queuePersist;
    private persist;
}
export declare const commentStore: CommentStore;
