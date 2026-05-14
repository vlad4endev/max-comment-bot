import type { Bot } from '@maxhub/max-bot-api';
/**
 * Channel post tracked for Mini App comments (MAX message id is {@link Post.message_mid}).
 */
export interface Post {
    post_id: string;
    chat_id: number;
    message_mid: string;
    text: string;
    photo_url?: string;
    comment_count: number;
    timestamp: string;
}
/**
 * JSON-backed map of posts by `post_id`, with async persistence under `data/posts.json`.
 */
export declare class PostStore {
    private readonly byId;
    private readonly filePath;
    private persistChain;
    constructor(filePath?: string);
    /**
     * Loads posts from disk into memory (replaces cache).
     */
    loadFromDisk(): Promise<void>;
    /**
     * Persists or replaces a post in memory and queues disk write.
     */
    savePost(post: Post): void;
    /**
     * Returns a post by id or `null`.
     */
    getPost(postId: string): Post | null;
    /**
     * All posts in a channel (for /status counts).
     */
    getPostsByChatId(chatId: number): Post[];
    /**
     * Increments {@link Post.comment_count} and persists. Returns new count or `null` if unknown post.
     */
    incrementCommentCount(postId: string): number | null;
    /**
     * Updates the channel message inline keyboard to show the current comment count.
     */
    updateButtonCaption(bot: Bot, post: Post): Promise<void>;
    private queuePersist;
    private persist;
}
/**
 * Builds Mini App open URL with required query params (URL-encoded).
 */
export declare function buildMiniAppUrl(miniAppBase: string, postId: string, chatId: number, extra?: Record<string, string>): string;
export declare const postStore: PostStore;
