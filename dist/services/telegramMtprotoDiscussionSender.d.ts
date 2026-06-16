/**
 * Отправка комментариев в TG-обсуждение от имени канала или чата (sendAs).
 * Bot API не умеет публиковать от канала/чата — только MTProto user-сессия.
 */
export type DiscussionSendAsMode = 'channel' | 'chat';
export declare function mtprotoDiscussionSenderConfigured(): boolean;
/**
 * Публикует сообщение в чат обсуждений от имени канала или самой группы обсуждений.
 *
 * - `channel` — подпись канала (как «ответ от канала» в комментариях)
 * - `chat` — от имени группы обсуждений (как «анонимный админ» в TG)
 */
export declare function sendDiscussionMessageAsPeer(mode: DiscussionSendAsMode, discussionChatId: number, channelKey: string | null, text: string, replyToMessageId: number): Promise<number | null>;
/** @deprecated используйте sendDiscussionMessageAsPeer */
export declare function sendDiscussionMessageAsChannel(discussionChatId: number, channelKey: string, text: string, replyToMessageId: number): Promise<number | null>;
