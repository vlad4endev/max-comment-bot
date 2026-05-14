"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createWebhookApp = createWebhookApp;
const express_1 = __importDefault(require("express"));
const logger_1 = require("../utils/logger");
const dispatchUpdate_1 = require("./dispatchUpdate");
const MAX_SECRET_HEADER = 'x-max-bot-api-secret';
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function looksLikeUpdate(body) {
    if (!isRecord(body)) {
        return false;
    }
    const type = body.update_type;
    return typeof type === 'string' && type.length > 0;
}
function createWebhookApp(options) {
    const app = (0, express_1.default)();
    app.disable('x-powered-by');
    app.get('/health', (_req, res) => {
        res.status(200).type('text/plain').send('ok');
    });
    app.post(options.webhookPath, express_1.default.json({ limit: '512kb' }), async (req, res) => {
        if (options.webhookSecret) {
            const got = req.get(MAX_SECRET_HEADER);
            if (got !== options.webhookSecret) {
                logger_1.logger.warn('Webhook: отклонён запрос с неверным или пустым секретом');
                res.status(403).end();
                return;
            }
        }
        if (!looksLikeUpdate(req.body)) {
            logger_1.logger.warn('Webhook: тело запроса не похоже на Update');
            res.status(400).json({ error: 'invalid update payload' });
            return;
        }
        try {
            await (0, dispatchUpdate_1.dispatchBotUpdate)(options.bot, req.body);
            res.status(200).end();
        }
        catch (err) {
            logger_1.logger.error('Webhook: ошибка обработки update', err);
            res.status(200).end();
        }
    });
    return app;
}
//# sourceMappingURL=createWebhookApp.js.map