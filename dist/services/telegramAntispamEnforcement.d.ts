import type { AntispamEvaluation } from './antispamService';
/** Ограничение на время после обычного спама (удаление / флуд). */
export declare const TG_ANTISPAM_MUTE_SECONDS = 3600;
/** Ограничение после бана (delete_and_ban, blacklist). */
export declare const TG_ANTISPAM_BAN_MUTE_SECONDS = 86400;
export interface TelegramAntispamEnforcementInput {
    token: string;
    chatId: number;
    messageId: number;
    /** Telegram user id для restrictChatMember; null — только удаление. */
    telegramUserId: number | null;
    channelChatId: number;
    evaluation: AntispamEvaluation;
}
/**
 * Удаляет спам-сообщение в TG-обсуждении и при необходимости ограничивает автора.
 */
export declare function enforceTelegramAntispamAction(input: TelegramAntispamEnforcementInput): Promise<{
    deleted: boolean;
    restricted: boolean;
}>;
