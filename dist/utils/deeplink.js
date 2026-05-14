"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateDeeplink = generateDeeplink;
exports.parsePayload = parsePayload;
const config_1 = require("../config");
const logger_1 = require("./logger");
const MAX_START_PAYLOAD_LENGTH = 128;
function generateDeeplink(payload, botNickname) {
    if (payload.length > MAX_START_PAYLOAD_LENGTH) {
        throw new Error(`payload не может быть длиннее ${MAX_START_PAYLOAD_LENGTH} символов (сейчас ${payload.length})`);
    }
    const nick = botNickname ?? config_1.config.BOT_NICKNAME;
    const url = `https://max.ru/${nick}?start=${encodeURIComponent(payload)}`;
    logger_1.logger.debug('Сгенерирован deeplink MAX', {
        botNickname: nick,
        payloadLength: payload.length,
    });
    return url;
}
function parsePayload(payload) {
    if (payload === null) {
        return null;
    }
    const underscore = payload.indexOf('_');
    if (underscore <= 0 || underscore === payload.length - 1) {
        return null;
    }
    const type = payload.slice(0, underscore);
    const id = payload.slice(underscore + 1);
    if (type === '' || id === '') {
        return null;
    }
    return { type, id };
}
//# sourceMappingURL=deeplink.js.map