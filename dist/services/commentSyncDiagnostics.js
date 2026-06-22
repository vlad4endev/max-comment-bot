"use strict";
/**
 * Диагностика и восстановление синхронизации комментариев MAX ↔ Telegram.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.STALE_UNDELIVERABLE_DAYS = void 0;
exports.staleUndeliverableCutoffIso = staleUndeliverableCutoffIso;
exports.countStaleUndeliverableComments = countStaleUndeliverableComments;
exports.countFreshBlockedComments = countFreshBlockedComments;
exports.purgeStaleUndeliverableComments = purgeStaleUndeliverableComments;
exports.diagnoseCommentSync = diagnoseCommentSync;
exports.repairMissingThreadMappings = repairMissingThreadMappings;
exports.bootstrapCommentSyncOnStartup = bootstrapCommentSyncOnStartup;
const axios_1 = __importDefault(require("axios"));
const adminPanelState_1 = require("../api/adminPanelState");
const database_1 = require("../db/database");
const adminLogFormat_1 = require("../utils/adminLogFormat");
const logger_1 = require("../utils/logger");
const telegramSyncErrors_1 = require("../utils/telegramSyncErrors");
const postCommentMappingStore_1 = require("./postCommentMappingStore");
const telegramDiscussionThreadResolver_1 = require("./telegramDiscussionThreadResolver");
const mtprotoConfigStore_1 = require("./mtprotoConfigStore");
const resolveTelegramBotToken_1 = require("./resolveTelegramBotToken");
const telegramRateLimiter_1 = require("../utils/telegramRateLimiter");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TG_API = 'https://api.telegram.org';
exports.STALE_UNDELIVERABLE_DAYS = 30;
function staleUndeliverableCutoffIso() {
    return new Date(Date.now() - exports.STALE_UNDELIVERABLE_DAYS * 24 * 60 * 60 * 1000).toISOString();
}
function countStaleUndeliverableComments(chainId, staleCutoff) {
    const cutoff = staleCutoff ?? staleUndeliverableCutoffIso();
    const row = (0, database_1.getDb)()
        .prepare(`SELECT COUNT(*) AS n FROM comments c
       JOIN posts p ON p.post_id = c.post_id
       LEFT JOIN post_comment_mapping m ON m.max_mid = p.message_mid AND m.chain_id = ?
       WHERE (c.tg_comment_id IS NULL OR c.tg_comment_id = 0)
         AND (c.source IS NULL OR c.source = 'max')
         AND (m.tg_thread_msg_id IS NULL OR m.tg_thread_msg_id = 0)
         AND p.timestamp < ?`)
        .get(chainId, cutoff);
    return Number(row.n) || 0;
}
function countFreshBlockedComments(chainId, staleCutoff) {
    const cutoff = staleCutoff ?? staleUndeliverableCutoffIso();
    const row = (0, database_1.getDb)()
        .prepare(`SELECT COUNT(*) AS n FROM comments c
       JOIN posts p ON p.post_id = c.post_id
       LEFT JOIN post_comment_mapping m ON m.max_mid = p.message_mid AND m.chain_id = ?
       WHERE (c.tg_comment_id IS NULL OR c.tg_comment_id = 0)
         AND (c.source IS NULL OR c.source = 'max')
         AND (m.tg_thread_msg_id IS NULL OR m.tg_thread_msg_id = 0)
         AND p.timestamp >= ?`)
        .get(chainId, cutoff);
    return Number(row.n) || 0;
}
/** Списывает комментарии к постам старше STALE_UNDELIVERABLE_DAYS без треда (tg_comment_id = -1). */
function purgeStaleUndeliverableComments(chainId) {
    const staleCutoff = staleUndeliverableCutoffIso();
    const result = (0, database_1.getDb)()
        .prepare(`UPDATE comments
       SET tg_comment_id = -1
       WHERE (tg_comment_id IS NULL OR tg_comment_id = 0)
         AND (source IS NULL OR source = 'max')
         AND post_id IN (
           SELECT p.post_id FROM posts p
           LEFT JOIN post_comment_mapping m
             ON m.max_mid = p.message_mid AND m.chain_id = ?
           WHERE (m.tg_thread_msg_id IS NULL OR m.tg_thread_msg_id = 0)
             AND p.timestamp < ?
         )`)
        .run(chainId, staleCutoff);
    return Number(result.changes) || 0;
}
function resolveBotTokenForChain(chain) {
    const fromChain = chain.bot_token?.trim();
    if (fromChain) {
        return fromChain;
    }
    return (0, resolveTelegramBotToken_1.resolveTelegramBotToken)();
}
async function getBotUserId(token) {
    try {
        const { data } = await axios_1.default.get(`${TG_API}/bot${token}/getMe`, { timeout: 10_000 });
        const id = data.result?.id;
        return typeof id === 'number' && id > 0 ? id : null;
    }
    catch {
        return null;
    }
}
async function isBotChatAdmin(token, chatId, botId) {
    try {
        const { data } = await axios_1.default.get(`${TG_API}/bot${token}/getChatMember`, {
            params: { chat_id: chatId, user_id: botId },
            timeout: 15_000,
        });
        const status = data.result?.status ?? '';
        return status === 'administrator' || status === 'creator';
    }
    catch {
        return false;
    }
}
async function isBotChatMember(token, chatId, botId) {
    try {
        const { data } = await axios_1.default.get(`${TG_API}/bot${token}/getChatMember`, {
            params: { chat_id: chatId, user_id: botId },
            timeout: 15_000,
        });
        const status = data.result?.status ?? '';
        return status !== 'left' && status !== 'kicked' && status !== '';
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if ((0, telegramSyncErrors_1.isTelegramForbiddenError)(msg)) {
            return false;
        }
        return false;
    }
}
function resolveChannelChatId(chain) {
    const fromId = chain.tg_channel_id?.trim();
    if (fromId) {
        return fromId;
    }
    const username = chain.tg_username?.trim();
    if (username) {
        return username.startsWith('@') ? username : `@${username}`;
    }
    return null;
}
function countPendingMaxToTelegram(maxChatId) {
    const row = (0, database_1.getDb)()
        .prepare(`SELECT COUNT(*) AS n
       FROM comments c
       JOIN posts p ON p.post_id = c.post_id
       WHERE ABS(p.chat_id) = ?
         AND (c.source IS NULL OR c.source = 'max')
         AND (c.tg_comment_id IS NULL OR c.tg_comment_id = 0)`)
        .get(Math.abs(maxChatId));
    return Number(row.n) || 0;
}
function analyzeLogSignals(entries) {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    let invalid_message_id = 0;
    let send_as_peer_invalid = 0;
    let forbidden = 0;
    let unauthorized = 0;
    let flood_wait = 0;
    let no_thread_mapping = 0;
    for (const entry of entries) {
        if (entry.ts) {
            const ts = Date.parse(entry.ts);
            if (Number.isFinite(ts) && ts < cutoff) {
                continue;
            }
        }
        const hay = `${entry.message} ${entry.raw}`.toLowerCase();
        if (hay.includes('no thread mapping')) {
            no_thread_mapping += 1;
        }
        if ((0, telegramSyncErrors_1.isInvalidTelegramMessageIdError)(hay)) {
            invalid_message_id += 1;
        }
        if ((0, telegramSyncErrors_1.isSendAsPeerInvalidError)(hay)) {
            send_as_peer_invalid += 1;
        }
        if ((0, telegramSyncErrors_1.isTelegramForbiddenError)(hay)) {
            forbidden += 1;
        }
        if ((0, telegramSyncErrors_1.isTelegramUnauthorizedError)(hay)) {
            unauthorized += 1;
        }
        if (hay.includes('flood_wait') || hay.includes('retry after')) {
            flood_wait += 1;
        }
    }
    return { invalid_message_id, send_as_peer_invalid, forbidden, unauthorized, flood_wait, no_thread_mapping };
}
function buildChainIssues(input) {
    const issues = [];
    const { chain, tokenPresent, botId, discussionChatId, botChannelAdmin, botDiscussionMember, mappingStats, mappingChannelMismatch, pendingMaxToTg, staleUndeliverable, freshBlocked, } = input;
    if (tokenPresent && botId == null) {
        issues.push({
            severity: 'critical',
            code: 'telegram_token_invalid',
            title: 'Токен Telegram недействителен (401)',
            description: 'getMe не проходит — бот не авторизован в Telegram API.',
            what_to_do: 'Обновите токен в Админка → Интеграции или TG_TOKEN в .env, проверьте бота в @BotFather и перезапустите сервис.',
        });
        return issues;
    }
    if (chain.forward_comments !== true) {
        issues.push({
            severity: 'info',
            code: 'forward_comments_disabled',
            title: 'Синхронизация комментариев выключена',
            description: 'Цепочка не слушает группу обсуждений.',
            what_to_do: 'Включите forward_comments в настройках цепочки TG→MAX.',
        });
        return issues;
    }
    if (discussionChatId == null) {
        issues.push({
            severity: 'critical',
            code: 'no_discussion_group',
            title: 'Не привязана группа обсуждений',
            description: 'Telegram-канал не имеет linked discussion group или бот не может её прочитать.',
            what_to_do: 'В настройках канала Telegram включите «Обсуждение» и укажите tg_discussion_chat_id в цепочке.',
        });
    }
    if (botChannelAdmin === false) {
        issues.push({
            severity: 'critical',
            code: 'bot_not_channel_admin',
            title: 'Бот не администратор канала',
            description: 'Без прав администратора бот не может работать с комментариями канала.',
            what_to_do: 'Добавьте бота администратором TG-канала и обновите токен при необходимости.',
        });
    }
    if (discussionChatId != null && botDiscussionMember === false) {
        issues.push({
            severity: 'critical',
            code: 'bot_not_in_discussion',
            title: 'Бот не в группе обсуждений',
            description: 'Бот не получает авто-репосты постов и комментарии из discussion group.',
            what_to_do: 'Добавьте бота в группу обсуждений с правом читать сообщения.',
        });
    }
    if (!(0, mtprotoConfigStore_1.isMtprotoSessionReady)()) {
        issues.push({
            severity: 'warning',
            code: 'mtproto_not_configured',
            title: 'MTProto-сессия не настроена',
            description: 'Без user-сессии нельзя восстановить thread mapping и отправлять от имени канала.',
            what_to_do: 'Настройте TG_API_ID, TG_API_HASH и TG_USER_SESSION в mtproto-config.',
        });
    }
    if (chain.tg_discussion_send_as !== 'chat' && !(0, mtprotoConfigStore_1.isMtprotoSessionReady)()) {
        issues.push({
            severity: 'warning',
            code: 'send_as_channel_unavailable',
            title: 'Отправка от имени канала недоступна',
            description: 'SEND_AS_PEER_INVALID возможен без MTProto и прав на send-as.',
            what_to_do: 'Переключите tg_discussion_send_as на chat или настройте MTProto user-сессию.',
        });
    }
    if (mappingChannelMismatch > 0) {
        issues.push({
            severity: 'warning',
            code: 'mapping_channel_mismatch',
            title: 'Маппинги привязаны к другому TG-каналу',
            description: `${mappingChannelMismatch} записей post_comment_mapping имеют tg_chat_id, не совпадающий с настройками цепочки.`,
            what_to_do: 'Проверьте tg_channel_id / tg_username в цепочке или пересоздайте связку. После деплоя repair-threads использует tg_chat_id из маппинга.',
        });
    }
    if (mappingStats.missing_thread > 0) {
        issues.push({
            severity: mappingStats.missing_thread > mappingStats.with_thread ? 'critical' : 'warning',
            code: 'missing_thread_mappings',
            title: 'Посты без привязки к тредам',
            description: `${mappingStats.missing_thread} из ${mappingStats.total} постов не имеют tg_thread_msg_id.`,
            what_to_do: 'Запустите POST /admin/comment-sync/repair-threads для восстановления через GetDiscussionMessage.',
        });
    }
    if (pendingMaxToTg > 0) {
        issues.push({
            severity: 'warning',
            code: 'pending_max_to_tg',
            title: 'Комментарии MAX ждут отправки в TG',
            description: `${pendingMaxToTg} комментариев из miniapp ещё не синхронизированы в Telegram.`,
            what_to_do: 'Исправьте thread mapping и права бота. Синхронизация идёт пакетами (TELEGRAM_COMMENT_SYNC_BATCH_SIZE) с интервалом MAX_COMMENT_SYNC_INTERVAL_MS.',
        });
    }
    if (staleUndeliverable > 0) {
        issues.push({
            severity: 'info',
            code: 'stale_undeliverable_comments',
            title: `Комментарии к постам старше ${exports.STALE_UNDELIVERABLE_DAYS} дней без треда`,
            description: `${staleUndeliverable} комментариев не могут быть доставлены — Telegram не возвращает тред для старых постов. Будут списаны автоматически.`,
            what_to_do: 'Ничего не требуется — списываются автоматически при старте синка.',
        });
    }
    if (freshBlocked > 0) {
        issues.push({
            severity: 'warning',
            code: 'fresh_blocked_comments',
            title: 'Свежие комментарии ждут repair',
            description: `${freshBlocked} комментариев к постам младше ${exports.STALE_UNDELIVERABLE_DAYS} дней не могут быть доставлены — нет tg_thread_msg_id. Repair должен помочь.`,
            what_to_do: 'Запустите repair-threads с параметром only_with_pending=true',
        });
    }
    return issues;
}
async function diagnoseCommentSync(chainIdFilter) {
    const chains = (0, adminPanelState_1.listTgChainsSync)().filter((c) => !chainIdFilter || c.id === chainIdFilter);
    const mtprotoReady = (0, mtprotoConfigStore_1.isMtprotoSessionReady)();
    const mtprotoSource = (0, mtprotoConfigStore_1.resolveMtprotoCredentials)().source;
    const resultChains = [];
    for (const chain of chains) {
        const token = resolveBotTokenForChain(chain);
        const botId = token ? await getBotUserId(token) : null;
        const channelChatId = resolveChannelChatId(chain);
        const discussionChatId = token ? await (0, postCommentMappingStore_1.resolveDiscussionChatId)(token, chain) : null;
        let botChannelAdmin = null;
        if (token && botId != null && channelChatId) {
            botChannelAdmin = await isBotChatAdmin(token, channelChatId, botId);
        }
        let botDiscussionMember = null;
        if (token && botId != null && discussionChatId != null) {
            botDiscussionMember = await isBotChatMember(token, discussionChatId, botId);
        }
        const mappingStats = (0, postCommentMappingStore_1.countPostMappingThreadStats)(chain.id);
        const mappingChannelMismatch = (0, postCommentMappingStore_1.countMappingChannelIdMismatch)(chain.id);
        const pendingMaxToTg = countPendingMaxToTelegram(chain.max_chat_id);
        const staleUndeliverable = countStaleUndeliverableComments(chain.id);
        const freshBlocked = countFreshBlockedComments(chain.id);
        const issues = buildChainIssues({
            chain,
            tokenPresent: Boolean(token),
            botId,
            discussionChatId,
            botChannelAdmin,
            botDiscussionMember,
            mappingStats,
            mappingChannelMismatch,
            pendingMaxToTg,
            staleUndeliverable,
            freshBlocked,
        });
        resultChains.push({
            chain_id: chain.id,
            chain_name: chain.tg_username?.trim() || chain.tg_channel_id?.trim() || chain.id,
            active: chain.active !== false,
            forward_comments: chain.forward_comments === true,
            discussion_chat_id: discussionChatId,
            discussion_linked: discussionChatId != null,
            bot_channel_admin: botChannelAdmin,
            bot_discussion_member: botDiscussionMember,
            mtproto_ready: mtprotoReady,
            send_as_mode: chain.tg_discussion_send_as === 'chat' ? 'chat' : 'channel',
            mapping_stats: mappingStats,
            pending_max_to_tg: pendingMaxToTg,
            issues,
        });
    }
    const logEntries = (0, logger_1.getAdminLogTail)(1000)
        .map(adminLogFormat_1.parseAdminLogLine)
        .filter((e) => e !== null);
    const logSignals = analyzeLogSignals(logEntries);
    const recommendations = [];
    if (logSignals.invalid_message_id > 0) {
        recommendations.push('Обнаружены MSG_ID_INVALID: проверьте linked discussion group и запустите repair-threads.');
    }
    if (logSignals.send_as_peer_invalid > 0) {
        recommendations.push('Обнаружены SEND_AS_PEER_INVALID: проверьте права send-as или переключите tg_discussion_send_as на chat.');
    }
    if (logSignals.unauthorized > 0) {
        recommendations.push('Обнаружены ошибки 401/unauthorized: обновите токен Telegram в интеграциях и перезапустите сервис.');
    }
    if (logSignals.forbidden > 0) {
        recommendations.push('Обнаружены ошибки 403/forbidden: проверьте токен бота и права в канале/группе.');
    }
    if (logSignals.flood_wait > 0) {
        recommendations.push('Обнаружен FLOOD_WAIT: увеличьте TELEGRAM_API_MIN_INTERVAL_MS (рекомендуется 2000–3000) и уменьшите TELEGRAM_COMMENT_SYNC_BATCH_SIZE.');
    }
    if (!mtprotoReady) {
        recommendations.push(`MTProto не настроен (source: ${mtprotoSource}) — thread recovery ограничен.`);
    }
    if (recommendations.length === 0) {
        recommendations.push('Критичных сигналов в логах за 24ч не найдено. При проблемах запустите repair-threads.');
    }
    return {
        checked_at: new Date().toISOString(),
        chains: resultChains,
        log_signals_24h: logSignals,
        recommendations,
    };
}
async function repairMissingThreadMappings(chainId, limit = 30, options) {
    const mappings = (0, postCommentMappingStore_1.listMappingsMissingThread)(chainId, limit, {
        onlyWithPending: options?.onlyWithPending,
    });
    let repaired = 0;
    let failed = 0;
    let pendingCommentsRepaired = 0;
    const samples = [];
    for (let i = 0; i < mappings.length; i += 1) {
        const mapping = mappings[i];
        const maxMid = mapping.max_mid?.trim();
        if (!maxMid) {
            failed += 1;
            continue;
        }
        const hadPending = (0, postCommentMappingStore_1.countPendingMaxCommentsForMaxMid)(maxMid) > 0;
        try {
            const result = await (0, telegramDiscussionThreadResolver_1.ensurePostThreadMapping)(maxMid);
            const ok = Boolean(result?.tg_thread_chat_id && result?.tg_thread_msg_id);
            if (ok) {
                repaired += 1;
                if (hadPending) {
                    pendingCommentsRepaired += 1;
                }
            }
            else {
                failed += 1;
            }
            if (samples.length < 10) {
                samples.push({
                    max_mid: maxMid,
                    tg_msg_id: mapping.tg_msg_id,
                    ok,
                });
            }
        }
        catch (err) {
            failed += 1;
            logger_1.logger.warn('[commentSyncDiagnostics] repair thread mapping failed', {
                chainId,
                maxMid,
                tgMsgId: mapping.tg_msg_id,
                err,
            });
        }
        if (i < mappings.length - 1) {
            await sleep((0, telegramRateLimiter_1.getTelegramApiMinIntervalMs)());
        }
    }
    logger_1.logger.info('[commentSyncDiagnostics] repair thread mappings finished', {
        chainId,
        attempted: mappings.length,
        repaired,
        failed,
    });
    return {
        chain_id: chainId,
        attempted: mappings.length,
        repaired,
        failed,
        pending_comments_repaired: pendingCommentsRepaired,
        samples,
    };
}
/** На старте: backfill post_comment_mapping и починка тредов для активных цепочек. */
async function bootstrapCommentSyncOnStartup(options) {
    const threadRepairLimit = options?.threadRepairLimit ?? 5;
    const repairThreads = options?.repairThreads !== false;
    const mappingsBackfilled = (0, postCommentMappingStore_1.backfillPostCommentMappingsFromForwarded)();
    let chainsRepaired = 0;
    let threadsRepaired = 0;
    let threadsFailed = 0;
    if (repairThreads) {
        const chains = (0, adminPanelState_1.listTgChainsSync)().filter((c) => c.active !== false && c.forward_comments === true);
        for (const chain of chains) {
            const repair = await repairMissingThreadMappings(chain.id, threadRepairLimit);
            if (repair.attempted > 0) {
                chainsRepaired += 1;
                threadsRepaired += repair.repaired;
                threadsFailed += repair.failed;
            }
        }
    }
    const pendingRow = (0, database_1.getDb)()
        .prepare(`SELECT COUNT(*) AS n
       FROM comments c
       JOIN posts p ON p.post_id = c.post_id
       LEFT JOIN post_comment_mapping m ON m.max_mid = p.message_mid
       WHERE (c.source IS NULL OR c.source = 'max')
         AND (c.tg_comment_id IS NULL OR c.tg_comment_id = 0)
         AND m.id IS NULL`)
        .get();
    const pendingWithoutMapping = Number(pendingRow.n) || 0;
    const result = {
        mappings_backfilled: mappingsBackfilled,
        chains_repaired: chainsRepaired,
        threads_repaired: threadsRepaired,
        threads_failed: threadsFailed,
        pending_without_mapping: pendingWithoutMapping,
    };
    logger_1.logger.info('[commentSync] bootstrap on startup', result);
    if (pendingWithoutMapping > 0) {
        logger_1.logger.warn('[commentSync] комментарии без TG-маппинга не переносятся в Telegram — нужны посты из TG (forward_posts) или repair-threads', { pending_without_mapping: pendingWithoutMapping });
    }
    return result;
}
//# sourceMappingURL=commentSyncDiagnostics.js.map