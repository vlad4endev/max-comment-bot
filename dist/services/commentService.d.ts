export interface Comment {
    id: string;
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
    getByPostId(postId: string): Promise<Comment[]>;
    getById(id: string): Promise<Comment | null>;
    addReply(id: string, reply: string): Promise<Comment>;
    markAsApproved(id: string): Promise<Comment>;
}
export declare const commentService: CommentService;
