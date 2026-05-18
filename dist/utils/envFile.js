"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.upsertRootEnvVar = upsertRootEnvVar;
exports.removeRootEnvVar = removeRootEnvVar;
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const logger_1 = require("./logger");
const ENV_PATH = (0, node_path_1.join)(process.cwd(), '.env');
function formatEnvValue(value) {
    if (/[\s#"'\\]/.test(value)) {
        return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    }
    return value;
}
function parseEnvLine(line) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#'))
        return null;
    const eq = trimmed.indexOf('=');
    if (eq <= 0)
        return null;
    return { key: trimmed.slice(0, eq).trim(), raw: line };
}
/**
 * Добавляет или обновляет переменную в корневом `.env`.
 */
async function upsertRootEnvVar(key, value) {
    let lines = [];
    try {
        const content = await (0, promises_1.readFile)(ENV_PATH, 'utf8');
        lines = content.split('\n');
    }
    catch (err) {
        const code = err?.code;
        if (code !== 'ENOENT')
            throw err;
    }
    const newLine = `${key}=${formatEnvValue(value)}`;
    let replaced = false;
    const next = lines.map((line) => {
        const parsed = parseEnvLine(line);
        if (parsed?.key === key) {
            replaced = true;
            return newLine;
        }
        return line;
    });
    if (!replaced) {
        if (next.length > 0 && next[next.length - 1] !== '') {
            next.push('');
        }
        next.push(newLine);
    }
    const output = next.join('\n');
    await (0, promises_1.writeFile)(ENV_PATH, output.endsWith('\n') ? output : `${output}\n`, 'utf8');
    process.env[key] = value;
    logger_1.logger.info('envFile: updated', { key });
}
/**
 * Удаляет переменную из корневого `.env`.
 */
async function removeRootEnvVar(key) {
    let content;
    try {
        content = await (0, promises_1.readFile)(ENV_PATH, 'utf8');
    }
    catch (err) {
        const code = err?.code;
        if (code === 'ENOENT') {
            delete process.env[key];
            return;
        }
        throw err;
    }
    const lines = content.split('\n').filter((line) => parseEnvLine(line)?.key !== key);
    const output = lines.join('\n');
    await (0, promises_1.writeFile)(ENV_PATH, output.endsWith('\n') ? output : `${output}\n`, 'utf8');
    delete process.env[key];
    logger_1.logger.info('envFile: removed', { key });
}
//# sourceMappingURL=envFile.js.map