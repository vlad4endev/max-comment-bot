"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = void 0;
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
function getConfig() {
    const BOT_TOKEN = (process.env.BOT_TOKEN ?? '').trim();
    if (!BOT_TOKEN) {
        throw new Error('BOT_TOKEN не установлен');
    }
    const adminChatIdRaw = (process.env.ADMIN_CHAT_ID ?? '').trim();
    if (adminChatIdRaw === '') {
        throw new Error('ADMIN_CHAT_ID должен быть числом');
    }
    const adminParsed = Number(adminChatIdRaw);
    if (!Number.isFinite(adminParsed) || !Number.isInteger(adminParsed)) {
        throw new Error('ADMIN_CHAT_ID должен быть числом');
    }
    const BOT_NICKNAME = (process.env.BOT_NICKNAME ?? '').trim();
    if (!BOT_NICKNAME) {
        throw new Error('BOT_NICKNAME не установлен');
    }
    const NODE_ENV = process.env.NODE_ENV === 'production' ? 'production' : 'development';
    const portRaw = process.env.PORT;
    let PORT = 3000;
    if (portRaw !== undefined && portRaw !== '') {
        const parsed = Number.parseInt(portRaw, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
            PORT = parsed;
        }
    }
    return {
        BOT_TOKEN,
        ADMIN_CHAT_ID: adminParsed,
        BOT_NICKNAME,
        NODE_ENV,
        PORT,
    };
}
exports.config = getConfig();
//# sourceMappingURL=config.js.map