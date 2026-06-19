/** База стоп-слов с весами (antispam_v16 / v15b из n8n). */
export declare const STOP_WORDS_BY_SCORE: Record<number, string[]>;
export interface StopWordIndex {
    exact: Map<string, number>;
    partial: Array<[string, number]>;
}
export declare function buildStopWordIndexes(dict: Record<number, string[]>, extraExact?: Map<string, number>): StopWordIndex;
export declare function checkStopWords(tokens: string[], index: StopWordIndex): number;
