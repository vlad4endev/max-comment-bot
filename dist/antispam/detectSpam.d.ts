export interface AntispamDetectConfig {
    softMode: boolean;
    enabled: boolean;
    spamThreshold: number;
    banThreshold: number;
    captchaRequiredScore: number;
    emojiOveruseLimit: number;
    pureEmojiMaxTextLength: number;
    minDistinctCategories: number;
    blockLinks: boolean;
    emojiSpam: boolean;
    /** Доп. стоп-слова из админки (глобальные + канала) с весом. */
    extraStopWordWeight: number;
    extraStopWords: string[];
}
export declare const DEFAULT_ANTISPAM_DETECT_CONFIG: AntispamDetectConfig;
export type AntispamDetectAction = 'leave' | 'delete' | 'delete_and_ban' | 'captcha';
export interface AntispamDetectResult {
    action: AntispamDetectAction;
    spamScore: number;
    categories: string[];
}
/**
 * Скоринг и решение — порт detectSpam из antispam_v16 (n8n).
 */
export declare function detectSpam(text: string, config: AntispamDetectConfig): AntispamDetectResult;
