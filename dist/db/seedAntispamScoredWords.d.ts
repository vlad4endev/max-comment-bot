export declare const ANTISPAM_SCORE_TIERS: readonly [100, 80, 10, 9, 8, 7, 6, 5, 4, 3, 0];
export type ScoredWordsByScore = Record<number, string[]>;
/** Словарь по умолчанию (n8n v16) — для первичного заполнения и сброса. */
export declare function defaultScoredWordsByScore(): ScoredWordsByScore;
export declare function scoredWordsRowsToDict(rows: Array<{
    word: string;
    score: number;
}>): ScoredWordsByScore;
export declare function persistScoredWords(dict: ScoredWordsByScore): void;
export declare function loadScoredWordsFromDb(): ScoredWordsByScore;
/** Первичное заполнение antispam_scored_words из встроенной базы. */
export declare function seedAntispamScoredWordsIfEmpty(): void;
export declare function resetScoredWordsToDefault(): ScoredWordsByScore;
