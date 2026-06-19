"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_ANTISPAM_DETECT_CONFIG = void 0;
exports.detectSpam = detectSpam;
const normalize_1 = require("./normalize");
const stopWords_1 = require("./stopWords");
exports.DEFAULT_ANTISPAM_DETECT_CONFIG = {
    softMode: false,
    enabled: true,
    spamThreshold: 20,
    banThreshold: 100,
    captchaRequiredScore: 15,
    emojiOveruseLimit: 20,
    pureEmojiMaxTextLength: 5,
    minDistinctCategories: 2,
    blockLinks: true,
    emojiSpam: true,
    extraStopWordWeight: 90,
    extraStopWords: [],
};
const phonePattern = /\b\d{10,12}\b/;
const linkPattern = /(?:https?:\/\/|t\.me\/\+?|www\.)/i;
const adultPattern = /\b(?:секс|порно|интим)\b/i;
const cryptoPattern = /\b(?:btc|eth|крипт|казино)\b/i;
const emojiPattern = /[\u203C-\u3299\u{1F000}-\u{1FAFF}\uFE0F]/gu;
function countEmojis(text) {
    return (String(text).match(emojiPattern) ?? []).length;
}
function isPureEmoji(text, maxTextLength) {
    const n = countEmojis(text);
    const withoutEmoji = String(text).replace(emojiPattern, '').replace(/\s/g, '');
    return withoutEmoji.length <= maxTextLength && n >= 1;
}
let baseStopIndex = null;
function getBaseStopIndex() {
    if (!baseStopIndex) {
        baseStopIndex = (0, stopWords_1.buildStopWordIndexes)(stopWords_1.SPAM_WORDS_BY_SCORE);
    }
    return baseStopIndex;
}
function buildRuntimeStopIndex(extraStopWords, extraWeight) {
    const extraExact = new Map();
    for (const raw of extraStopWords) {
        const w = raw.trim().toLowerCase();
        if (!w) {
            continue;
        }
        if (w.includes(' ')) {
            continue;
        }
        extraExact.set(w, extraWeight);
    }
    const partial = [];
    for (const raw of extraStopWords) {
        const w = raw.trim().toLowerCase();
        if (w.includes(' ')) {
            partial.push([w, extraWeight]);
        }
    }
    const base = getBaseStopIndex();
    const exact = new Map(base.exact);
    for (const [k, v] of extraExact) {
        exact.set(k, Math.max(exact.get(k) ?? 0, v));
    }
    return { exact, partial: [...base.partial, ...partial] };
}
/**
 * Скоринг и решение — порт detectSpam из antispam_v16 (n8n).
 */
function detectSpam(text, config) {
    if (!config.enabled || !text.trim()) {
        return { action: 'leave', spamScore: 0, categories: [] };
    }
    const original = text.normalize('NFKC');
    const tokens = (0, normalize_1.normalizeAndStemWords)(original);
    let spamScore = 0;
    const categories = new Set();
    if (phonePattern.test(original)) {
        spamScore += 150;
        categories.add('hard');
    }
    if (adultPattern.test(original)) {
        spamScore += 60;
        categories.add('hard');
    }
    if (cryptoPattern.test(original)) {
        spamScore += 60;
        categories.add('hard');
    }
    const hasLink = linkPattern.test(original);
    if (hasLink && config.blockLinks) {
        spamScore += 60;
        categories.add('link');
    }
    const stopIndex = buildRuntimeStopIndex(config.extraStopWords, config.extraStopWordWeight);
    const swScore = (0, stopWords_1.checkStopWords)(tokens, stopIndex);
    if (swScore > 0) {
        spamScore += swScore;
        categories.add('stop');
    }
    if (hasLink && config.blockLinks && swScore > 0) {
        spamScore += 40;
        categories.add('combo');
    }
    if (config.emojiSpam) {
        const emojiCount = countEmojis(original);
        if (emojiCount > config.emojiOveruseLimit) {
            spamScore += 30;
            categories.add('emoji');
        }
        if (isPureEmoji(original, config.pureEmojiMaxTextLength) && emojiCount > 8) {
            spamScore += 50;
            categories.add('emoji');
        }
    }
    // Украинские маркеры в обфусцированном тексте
    const norm = (0, normalize_1.normalizeObfuscation)(original.toLowerCase());
    if (/\b(мені|допоможу|гривн|₴|виграй|заробляй)\b/u.test(norm)) {
        spamScore += 45;
        categories.add('uk');
    }
    const safeReduction = (0, stopWords_1.checkSafePhraseReduction)(tokens);
    if (safeReduction > 0) {
        spamScore = Math.max(0, spamScore - safeReduction);
        categories.add('safe');
    }
    let action = 'leave';
    if (spamScore >= config.banThreshold) {
        action = config.softMode ? 'leave' : 'delete_and_ban';
    }
    else if (spamScore >= config.spamThreshold) {
        if (categories.has('hard') || categories.size >= config.minDistinctCategories) {
            action = config.softMode ? 'leave' : 'delete';
        }
        else if (spamScore >= config.captchaRequiredScore) {
            action = 'captcha';
        }
    }
    else if (spamScore >= config.captchaRequiredScore) {
        action = 'captcha';
    }
    return { action, spamScore, categories: [...categories] };
}
//# sourceMappingURL=detectSpam.js.map