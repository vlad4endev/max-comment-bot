import type { AutopostRecord } from './autopostStore';
import type { AutopostSendResult } from './autopostTelegramSender';
/**
 * Публикует автопост в MAX-канал (HTML + медиа + инлайн-кнопка).
 */
export declare function sendAutopostToMax(token: string, post: AutopostRecord): Promise<AutopostSendResult>;
export declare function resolveMaxToken(): string | null;
