"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createHttpApp = createHttpApp;
exports.createWebhookApp = createWebhookApp;
const node_path_1 = require("node:path");
const compression_1 = __importDefault(require("compression"));
const express_1 = __importDefault(require("express"));
const adminRoutes_1 = require("../api/adminRoutes");
const adminPanelState_1 = require("../api/adminPanelState");
const channelImportRoutes_1 = require("../api/channelImportRoutes");
const integrationsRoutes_1 = require("../api/integrationsRoutes");
const routes_1 = require("../api/routes");
const adminAuth_1 = require("../middleware/adminAuth");
const database_1 = require("../db/database");
const logger_1 = require("../utils/logger");
const updateQueue_1 = require("../utils/updateQueue");
const dispatchUpdate_1 = require("./dispatchUpdate");
const telegramHealthService_1 = require("../services/telegramHealthService");
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
    app.use((0, compression_1.default)({
        threshold: 1024,
        filter: (req, res) => {
            if (req.headers['x-no-compression']) {
                return false;
            }
            return compression_1.default.filter(req, res);
        },
    }));
    app.get('/health', (_req, res) => {
        const db = (0, database_1.getDb)();
        const chains = (0, adminPanelState_1.listTgChainsSync)();
        const pendingComments = db
            .prepare(`SELECT COUNT(*) AS n FROM comments
         WHERE (tg_comment_id IS NULL OR tg_comment_id = 0)
           AND (source IS NULL OR source = 'max')`)
            .get();
        res.status(200).json({
            ok: true,
            uptime: Math.round(process.uptime()),
            chains: {
                total: chains.length,
                active: chains.filter((c) => c.active).length,
                forwarding: chains.filter((c) => c.forward_posts).length,
                missing_discussion: chains.filter((c) => c.forward_comments && !c.tg_discussion_chat_id)
                    .length,
            },
            comments: {
                pending_sync: Number(pendingComments.n) || 0,
            },
            memory: {
                heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
            },
            timestamp: new Date().toISOString(),
        });
    });
    app.get('/health/telegram', async (_req, res) => {
        try {
            const snapshot = await (0, telegramHealthService_1.probeTelegramBotApi)();
            const sources = (0, telegramHealthService_1.describeTelegramTokenSources)();
            res.status(snapshot.api_ok || !snapshot.has_token ? 200 : 503).json({
                ...snapshot,
                token_sources: sources,
            });
        }
        catch (err) {
            logger_1.logger.error('/health/telegram probe failed', err);
            res.status(503).json({
                checked_at: new Date().toISOString(),
                has_token: Boolean((0, telegramHealthService_1.getTelegramHealthSnapshot)().has_token),
                api_ok: false,
                error: 'probe failed',
            });
        }
    });
    app.get('/favicon.ico', (_req, res) => {
        res.redirect(302, '/admin/assets/favicon.svg');
    });
    app.get('/admin/login', (_req, res) => {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
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
        setHeaders(res, filePath) {
            if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
                res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
            }
        },
    }));
    app.get('/admin', (req, res) => {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
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
    /** Unmatched /api/* → JSON (not nginx HTML) when the request reaches the bot. */
    app.use('/api', (req, res) => {
        res.status(404).json({
            error: 'API route not found',
            method: req.method,
            path: req.originalUrl,
        });
    });
    const miniappRoot = (0, node_path_1.join)(process.cwd(), 'miniapp');
    const miniappIndex = (0, node_path_1.join)(miniappRoot, 'index.html');
    /** Без редиректа на `/miniapp/` — WebView MAX/Telegram иногда не следует за 301. */
    app.get('/miniapp', (_req, res) => {
        res.sendFile(miniappIndex, (err) => {
            if (err) {
                logger_1.logger.error('/miniapp: sendFile failed', err);
                if (!res.headersSent) {
                    res.status(500).end();
                }
            }
        });
    });
    app.use('/miniapp', express_1.default.static(miniappRoot, {
        etag: true,
        lastModified: true,
        redirect: false,
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