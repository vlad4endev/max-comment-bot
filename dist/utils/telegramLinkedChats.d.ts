export interface TelegramLinkedChatApiView {
    id: string;
    title: string;
    username: string | null;
    type: string;
    botIsAdmin: boolean;
}
/** Безопасное приведение linkedChats к ответу API (защита от битых данных в integrations.json). */
export declare function normalizeTelegramLinkedChatsForApi(linkedChats: unknown): TelegramLinkedChatApiView[];
