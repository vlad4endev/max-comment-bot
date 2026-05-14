export interface Comment {
    id: string;
    /** Чат, из которого пришёл комментарий (изоляция между каналами) */
    sourceChatId: number;
    postId: string;
    userId: number;
    userName: string;
    text: string;
    createdAt: Date;
    status: 'pending' | 'approved' | 'rejected';
    reply?: string;
    replyAt?: Date;
}
export declare class CommentService {
    private comments;
    create(data: Omit<Comment, 'id' | 'createdAt' | 'status'>): Promise<Comment>;
    getByPostId(postId: string, sourceChatId?: number): Promise<Comment[]>;
    /**
     * Количество комментариев, созданных в указанном чате.
     */
    countByChatId(sourceChatId: number): number;
    getById(id: string): Promise<Comment | null>;
    addReply(id: string, reply: string): Promise<Comment>;
    markAsApproved(id: string): Promise<Comment>;
}
export declare const commentService: CommentService;
