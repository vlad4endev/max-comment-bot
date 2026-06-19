export interface PostTemplateRecord {
    id: string;
    name: string;
    text: string;
    media: {
        type: 'photo' | 'video';
        path: string;
    }[];
    created_at: string;
    updated_at: string;
}
export declare function listPostTemplates(): PostTemplateRecord[];
export declare function getPostTemplateById(id: string): PostTemplateRecord | null;
export declare function createPostTemplate(input: {
    name: string;
    text: string;
    media?: PostTemplateRecord['media'];
}): PostTemplateRecord;
export declare function updatePostTemplate(id: string, patch: {
    name?: string;
    text?: string;
    media?: PostTemplateRecord['media'];
}): PostTemplateRecord | null;
export declare function deletePostTemplate(id: string): boolean;
