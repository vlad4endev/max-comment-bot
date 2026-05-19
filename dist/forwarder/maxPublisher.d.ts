export declare function sendTextToMax(token: string, chatId: string, text: string): Promise<void>;
export declare function sendPhotoFileToMax(token: string, chatId: string, filePath: string, caption: string): Promise<void>;
export declare function sendVideoFileToMax(token: string, chatId: string, filePath: string, caption: string): Promise<void>;
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
