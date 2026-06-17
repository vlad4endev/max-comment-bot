/**
 * Восстанавливает tg_thread_chat_id / tg_thread_msg_id для post_comment_mapping,
 * если авто-репост канала в группу обсуждений был пропущен (бот не был в группе и т.п.).
 */
import { type PostCommentMappingRow } from './postCommentMappingStore';
/**
 * Дополняет post_comment_mapping полями треда обсуждения, если они ещё не заданы.
 * @returns mapping с заполненными thread id или null, если восстановить не удалось
 */
export declare function ensurePostThreadMapping(maxMid: string): Promise<PostCommentMappingRow | null>;
