/**
 * Троттлированные уведомления оператору о критических ошибках синхронизации Telegram.
 */
import type { Bot } from '@maxhub/max-bot-api';
export declare function setTelegramSyncAlertBot(bot: Bot): void;
export declare function reportTelegramFloodWait(input: {
    method: string;
    chatId?: number | string;
    waitSeconds: number;
    description: string;
}): Promise<void>;
export declare function reportTelegramForbidden(input: {
    method: string;
    chatId?: number | string;
    description: string;
}): Promise<void>;
export declare function reportTelegramUnauthorized(input: {
    method: string;
    description: string;
}): Promise<void>;
