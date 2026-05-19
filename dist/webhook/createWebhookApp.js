"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createHttpApp = createHttpApp;
exports.createWebhookApp = createWebhookApp;
const node_path_1 = require("node:path");
const express_1 = __importDefault(require("express"));
const adminRoutes_1 = require("../api/adminRoutes");
const channelImportRoutes_1 = require("../api/channelImportRoutes");
const integrationsRoutes_1 = require("../api/integrationsRoutes");
const routes_1 = require("../api/routes");
const adminAuth_1 = require("../middleware/adminAuth");
const logger_1 = require("../utils/logger");
const updateQueue_1 = require("../utils/updateQueue");
const dispatchUpdate_1 = require("./dispatchUpdate");
const MAX_SECRET_HEADER = 'x-max-bot-api-secret';
/** Корень `admin-panel/` рядом с `dist/` (в Docker: `/app/admin-panel`). */
const adminPanelRoot = (0, node_path_1.join)(__dirname, '..', '..', 'admin-panel');
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
/**
 * Express-приложение: GET /health, статика Mini App (`/miniapp`), REST `/api`, опционально POST webhook.
 */
function createHttpApp(options) {
    const app = (0, express_1.default)();
    app.disable('x-powered-by');
    app.get('/health', (_req, res) => {
        res.status(200).type('text/plain').send('ok');
    });
    app.get('/favicon.ico', (_req, res) => {
        res.redirect(302, '/admin/assets/favicon.svg');
    });
    app.get('/admin/login', (_req, res) => {
        res.sendFile((0, node_path_1.join)(adminPanelRoot, 'login.html'), (err) => {
            if (err) {
                logger_1.logger.error('/admin/login: sendFile failed', err);
                if (!res.headersSent) {
                    res.status(500).end();
                }
            }
        });
    });
    app.use('/admin/assets', express_1.default.static((0, node_path_1.join)(adminPanelRoot, 'assets'), {
        etag: true,
        lastModified: true,
    }));
    app.get('/admin', (req, res) => {
        if (!(0, adminAuth_1.isAdminPanelSessionValid)(req)) {
            res.redirect(302, '/admin/login');
            return;
        }
        res.sendFile((0, node_path_1.join)(adminPanelRoot, 'admin.html'), (err) => {
            if (err) {
                logger_1.logger.error('/admin: sendFile failed', err);
                if (!res.headersSent) {
                    res.status(500).end();
                }
            }
        });
    });
    app.use('/api/admin', (0, adminRoutes_1.createAdminRouter)({ bot: options.bot }));
    app.use('/api/channel-import', (0, channelImportRoutes_1.createChannelImportRouter)());
    const integrationsDeps = { bot: options.bot };
    app.use('/api/integrations', (0, integrationsRoutes_1.createIntegrationsRouter)(integrationsDeps));
    app.use('/api/flows', (0, integrationsRoutes_1.createFlowsRouter)(integrationsDeps));
    app.use('/api/integrations-analytics', (0, integrationsRoutes_1.createIntegrationsAnalyticsRouter)());
    app.use('/api', (0, routes_1.createCommentApiRouter)({ bot: options.bot }));
    const miniappRoot = (0, node_path_1.join)(process.cwd(), 'miniapp');
    app.use('/miniapp', express_1.default.static(miniappRoot, {
        etag: true,
        lastModified: true,
        setHeaders(res, filePath) {
            if (filePath.endsWith('.html')) {
                res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
                res.setHeader('Pragma', 'no-cache');
                res.setHeader('Expires', '0');
            }
        },
    }));
    if (options.webhook) {
        const { path: webhookPath, secret: webhookSecret } = options.webhook;
        app.post(webhookPath, express_1.default.json({ limit: '512kb' }), async (req, res) => {
            if (webhookSecret) {
                const got = req.get(MAX_SECRET_HEADER);
                if (got !== webhookSecret) {
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
                await (0, updateQueue_1.enqueueUpdate)(() => (0, dispatchUpdate_1.dispatchBotUpdate)(options.bot, req.body));
                res.status(200).end();
            }
            catch (err) {
                logger_1.logger.error('Webhook: ошибка обработки update', err);
                res.status(200).end();
            }
        });
    }
    return app;
}
function createWebhookApp(options) {
    return createHttpApp({
        bot: options.bot,
        webhook: { path: options.webhookPath, secret: options.webhookSecret },
    });
}
//# sourceMappingURL=createWebhookApp.js.map