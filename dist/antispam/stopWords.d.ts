/** База стоп-слов с весами (antispam_v16 / v15b из n8n).
 *
 * Уровни:
 * - 100 — мгновенный бан-скор (спам/мат/рекрутинг)
 * - 80  — сильный сигнал
 * - 10–9 — финансовый/казино спам
 * - 8–7 — вакансии, ссылки, «пиши в лс»
 * - 5–4 — широкие маркеры заработка/рекламы
 * - 3   — слабые маркеры
 * - 0   — безопасные фразы (снижают итоговый score, не блокируют сами по себе)
 */
export declare const STOP_WORDS_BY_SCORE: Record<number, string[]>;
/** Фразы с весом 0 — легитимная тематика, снижают spam score. */
export declare const SAFE_PHRASES: string[];
/** Словарь для скоринга без нулевого уровня (только штрафы). */
export declare const SPAM_WORDS_BY_SCORE: Record<number, string[]>;
export interface StopWordIndex {
    exact: Map<string, number>;
    partial: Array<[string, number]>;
}
export declare function buildStopWordIndexes(dict: Record<number, string[]>, extraExact?: Map<string, number>): StopWordIndex;
export declare function checkStopWords(tokens: string[], index: StopWordIndex): number;
/** Снижение score за безопасные фразы (уровень 0). */
export declare function checkSafePhraseReduction(tokens: string[], safePhrases: string[]): number;
