/** Нормализация текста (порт antispam_v16 из n8n). */
export declare function foldHomoglyphs(text: string): string;
export declare function normalizeTextRaw(text?: string): string;
export declare function normalizeObfuscation(text?: string): string;
export declare function tokenize(text?: string): string[];
export declare function simpleStem(word: string): string;
export declare function normalizeAndStemWords(text: string): string[];
