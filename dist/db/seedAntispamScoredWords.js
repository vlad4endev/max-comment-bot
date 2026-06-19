"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ANTISPAM_SCORE_TIERS = void 0;
exports.defaultScoredWordsByScore = defaultScoredWordsByScore;
exports.scoredWordsRowsToDict = scoredWordsRowsToDict;
exports.persistScoredWords = persistScoredWords;
exports.loadScoredWordsFromDb = loadScoredWordsFromDb;
exports.seedAntispamScoredWordsIfEmpty = seedAntispamScoredWordsIfEmpty;
exports.resetScoredWordsToDefault = resetScoredWordsToDefault;
const stopWords_1 = require("../antispam/stopWords");
const logger_1 = require("../utils/logger");
const antispamDatabase_1 = require("./antispamDatabase");
const antispamStore_1 = require("../services/antispamStore");
exports.ANTISPAM_SCORE_TIERS = [100, 80, 10, 9, 8, 7, 6, 5, 4, 3, 0];
/** Словарь по умолчанию (n8n v16) — для первичного заполнения и сброса. */
function defaultScoredWordsByScore() {
    const out = {};
    for (const tier of exports.ANTISPAM_SCORE_TIERS) {
        out[tier] = [...(stopWords_1.STOP_WORDS_BY_SCORE[tier] ?? [])];
    }
    return out;
}
function flattenScoredWords(dict) {
    const wordToScore = new Map();
    for (const tier of exports.ANTISPAM_SCORE_TIERS) {
        for (const raw of dict[tier] ?? []) {
            const word = String(raw).trim().toLowerCase();
            if (!word) {
                continue;
            }
            wordToScore.set(word, Math.max(wordToScore.get(word) ?? tier, tier));
        }
    }
    return [...wordToScore.entries()].map(([word, score]) => ({ word, score }));
}
function scoredWordsRowsToDict(rows) {
    const out = {};
    for (const tier of exports.ANTISPAM_SCORE_TIERS) {
        out[tier] = [];
    }
    for (const row of rows) {
        const word = row.word.trim().toLowerCase();
        if (!word) {
            continue;
        }
        const score = exports.ANTISPAM_SCORE_TIERS.includes(row.score)
            ? row.score
            : 5;
        if (!out[score]) {
            out[score] = [];
        }
        out[score].push(word);
    }
    for (const tier of exports.ANTISPAM_SCORE_TIERS) {
        out[tier] = [...new Set(out[tier] ?? [])].sort((a, b) => a.localeCompare(b, 'ru'));
    }
    return out;
}
function persistScoredWords(dict) {
    const db = (0, antispamDatabase_1.getAntispamDb)();
    const rows = flattenScoredWords(dict);
    const tx = db.transaction(() => {
        db.prepare('DELETE FROM antispam_scored_words').run();
        const insert = db.prepare('INSERT INTO antispam_scored_words (word, score) VALUES (?, ?)');
        for (const row of rows) {
            insert.run(row.word, row.score);
        }
    });
    tx();
}
function loadScoredWordsFromDb() {
    const rows = (0, antispamDatabase_1.getAntispamDb)()
        .prepare('SELECT word, score FROM antispam_scored_words ORDER BY score DESC, word ASC')
        .all();
    return scoredWordsRowsToDict(rows);
}
/** Первичное заполнение antispam_scored_words из встроенной базы. */
function seedAntispamScoredWordsIfEmpty() {
    (0, antispamDatabase_1.getAntispamDb)();
    if ((0, antispamDatabase_1.getAntispamDbMeta)('scored_words_seeded') === '1') {
        return;
    }
    const count = (0, antispamDatabase_1.getAntispamDb)().prepare('SELECT COUNT(*) AS n FROM antispam_scored_words').get().n;
    if (count > 0) {
        (0, antispamDatabase_1.setAntispamDbMeta)('scored_words_seeded', '1');
        return;
    }
    persistScoredWords(defaultScoredWordsByScore());
    (0, antispamDatabase_1.setAntispamDbMeta)('scored_words_seeded', '1');
    (0, antispamStore_1.reloadAntispamStore)();
    logger_1.logger.info('seedAntispamScoredWordsIfEmpty: loaded default scored word base');
}
function resetScoredWordsToDefault() {
    const dict = defaultScoredWordsByScore();
    persistScoredWords(dict);
    (0, antispamStore_1.reloadAntispamStore)();
    return dict;
}
//# sourceMappingURL=seedAntispamScoredWords.js.map