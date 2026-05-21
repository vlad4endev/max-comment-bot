export declare function notifyTelegramAdminsNewMiniappComment(input: {
    commentId: string;
    maxChannelChatId: number;
    postText: string;
    channelTitle: string;
    username: string;
    commentText: string;
    commentPhotoUrls?: string[];
    postId: string;
    messageMid?: string;
}): Promise<void>;
