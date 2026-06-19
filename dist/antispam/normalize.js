"use strict";
/** Нормализация текста (порт antispam_v16 из n8n). */
Object.defineProperty(exports, "__esModule", { value: true });
exports.foldHomoglyphs = foldHomoglyphs;
exports.normalizeTextRaw = normalizeTextRaw;
exports.normalizeObfuscation = normalizeObfuscation;
exports.tokenize = tokenize;
exports.simpleStem = simpleStem;
exports.normalizeAndStemWords = normalizeAndStemWords;
const HOMOGLYPH_MAP = {
    '0': 'o',
    '1': 'i',
    '3': 'e',
    '4': 'a',
    '5': 's',
    '7': 't',
    $: 's',
    '|': 'l',
    '!': 'i',
    'ё': 'е',
    'Ё': 'Е',
    'ї': 'и',
    'Ї': 'И',
    'і': 'и',
    'І': 'И',
    'є': 'е',
    'Є': 'Е',
    'ґ': 'г',
    'Ґ': 'Г',
    c: 'с',
    C: 'С',
    e: 'е',
    E: 'Е',
    o: 'о',
    O: 'О',
    p: 'р',
    P: 'Р',
    x: 'х',
    X: 'Х',
    a: 'а',
    A: 'А',
    y: 'у',
    Y: 'У',
    k: 'к',
    K: 'К',
    m: 'м',
    M: 'М',
    h: 'н',
    H: 'Н',
    b: 'в',
    B: 'В',
};
const STEM_SUFFIXES = [
    'ами',
    'ями',
    'ах',
    'ях',
    'ей',
    'иями',
    'ыми',
    'ого',
    'его',
    'ому',
    'ые',
    'ая',
    'ов',
    'ев',
    'ка',
    'ки',
    'ок',
    'ек',
    'ный',
    'ная',
    'ость',
    'ать',
    'ить',
    'ться',
    'ся',
    'ый',
    'ой',
];
function foldHomoglyphs(text) {
    return Array.from(text)
        .map((ch) => HOMOGLYPH_MAP[ch] ?? ch)
        .join('');
}
function normalizeTextRaw(text = '') {
    return text
        .normalize('NFKC')
        .replace(/[^\p{L}\p{N}\s@#.-]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
function normalizeObfuscation(text = '') {
    return foldHomoglyphs(text.normalize('NFKC')).replace(/[\.\-\_\*\u200b\u200c\u200d\u2060]+/g, '');
}
function tokenize(text = '') {
    return normalizeObfuscation(normalizeTextRaw(text).toLowerCase())
        .split(/\s+/)
        .filter(Boolean);
}
function simpleStem(word) {
    if (!word) {
        return word;
    }
    for (const suffix of STEM_SUFFIXES) {
        if (word.length > suffix.length + 3 && word.endsWith(suffix)) {
            return word.slice(0, -suffix.length);
        }
    }
    return word;
}
function normalizeAndStemWords(text) {
    return tokenize(text).map(simpleStem);
}
//# sourceMappingURL=normalize.js.map