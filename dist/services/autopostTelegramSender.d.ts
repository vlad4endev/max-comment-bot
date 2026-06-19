import type { AutopostRecord } from './autopostStore';
export interface AutopostSendResult {
    ok: boolean;
    /** true, если инлайн-кнопка ушла отдельным сообщением (альбом). */
    buttonSentSeparately?: boolean;
    warning?: string;
}
/**
 * Публикует автопост в Telegram-канал.
 * sendMediaGroup не поддерживает inline-кнопки — при альбоме кнопки уходят отдельным сообщением.
 */
export declare function sendAutopostToTelegram(token: string, post: AutopostRecord): Promise<AutopostSendResult>;
