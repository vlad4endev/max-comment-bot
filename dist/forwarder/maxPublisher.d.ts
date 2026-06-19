type MaxAttachmentType = 'image' | 'video' | 'file';
interface MaxAttachmentFromFile {
    type: MaxAttachmentType;
    filePath: string;
    filename?: string;
    contentType?: string;
}
export interface MaxSendOptions {
    keyboard?: {
        text: string;
        url: string;
    }[][] | null;
    /** @deprecated use keyboard */
    button?: {
        text: string;
        url: string;
    };
}
export declare function sendTextToMax(token: string, chatId: string, text: string, options?: MaxSendOptions): Promise<void>;
export declare function sendPhotoFileToMax(token: string, chatId: string, filePath: string, caption: string, options?: MaxSendOptions): Promise<void>;
export declare function sendVideoFileToMax(token: string, chatId: string, filePath: string, caption: string, options?: MaxSendOptions): Promise<void>;
export declare function sendDocumentFileToMax(token: string, chatId: string, filePath: string, caption: string, options?: {
    filename?: string;
    contentType?: string;
}): Promise<void>;
export declare function sendPhotoToMax(token: string, chatId: string, photoUrl: string, caption: string): Promise<void>;
export declare function sendVideoToMax(token: string, chatId: string, videoUrl: string, caption: string): Promise<void>;
export declare function sendDocumentToMax(token: string, chatId: string, documentUrl: string, caption: string, options?: {
    filename?: string;
    contentType?: string;
}): Promise<void>;
export declare function sendMediaAlbumFilesToMax(token: string, chatId: string, caption: string, media: MaxAttachmentFromFile[], options?: MaxSendOptions): Promise<void>;
export {};
