"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveTgChainChannelFields = resolveTgChainChannelFields;
exports.repairTgChainsForForwarding = repairTgChainsForForwarding;
exports.repairTgChainForwardPostsSince = repairTgChainForwardPostsSince;
exports.syncTgChainBotTokensOnTelegramReconnect = syncTgChainBotTokensOnTelegramReconnect;
exports.repairStaleTgChainBotTokens = repairStaleTgChainBotTokens;
exports.repairMiniappChainsForwardComments = repairMiniappChainsForwardComments;
const adminPanelState_1 = require("../api/adminPanelState");
const integrationPlatformClient_1 = require("./integrationPlatformClient");
const resolveTelegramBotToken_1 = require("./resolveTelegramBotToken");
const telegramHealthService_1 = require("./telegramHealthService");
const logger_1 = require("../utils/logger");
/** Нормализует @username / -100… / t.me/… в канонический chat_id для пересылки постов. */
async function resolveTgChainChannelFields(token, tgRaw) {
    const trimmed = tgRaw.trim();
    if (!trimmed) {
        return null;
    }
    const fromApi = await (0, integrationPlatformClient_1.resolveTelegramChannelChatIdFromKey)(token, trimmed);
    if (fromApi) {
        return {
            tg_channel_id: fromApi.chatId,
            tg_username: fromApi.username?.replace(/^@/, '') ?? '',
        };
    }
    const numeric = trimmed.replace(/^@/, '');
    if (/^-100\d+$/.test(numeric)) {
        return { tg_channel_id: numeric, tg_username: '' };
    }
    const asUname = trimmed.replace(/^@/, '');
    if (asUname && !/^-?\d+$/.test(asUname)) {
        return { tg_channel_id: '', tg_username: asUname };
    }
    return null;
}
function chainNeedsChannelIdRepair(chain) {
    const id = chain.tg_channel_id?.trim() ?? '';
    return id === '' || !/^-100\d+$/.test(id);
}
/** Починка связок из админки: tg_channel_id, пустой bot_token. */
async function repairTgChainsForForwarding() {
    await (0, adminPanelState_1.ensureAdminPanelStateLoaded)();
    const token = (0, resolveTelegramBotToken_1.resolveTelegramBotToken)();
    if (!token) {
        return { tokenRepaired: 0, channelIdRepaired: 0 };
    }
    const chains = await (0, adminPanelState_1.listTgChains)();
    let tokenRepaired = 0;
    let channelIdRepaired = 0;
    for (const chain of chains) {
        const patch = {};
        if (!chain.bot_token?.trim()) {
            patch.bot_token = token;
            tokenRepaired += 1;
        }
        if (chainNeedsChannelIdRepair(chain)) {
            const raw = chain.tg_channel_id?.trim() ||
                (chain.tg_username?.trim() ? `@${chain.tg_username.trim().replace(/^@/, '')}` : '');
            if (raw) {
                const resolved = await resolveTgChainChannelFields(token, raw);
                if (resolved?.tg_channel_id && /^-100\d+$/.test(resolved.tg_channel_id)) {
                    patch.tg_channel_id = resolved.tg_channel_id;
                    if (resolved.tg_username) {
                        patch.tg_username = resolved.tg_username;
                    }
                    channelIdRepaired += 1;
                }
            }
        }
        if (Object.keys(patch).length > 0) {
            await (0, adminPanelState_1.updateTgChain)(chain.id, patch);
        }
    }
    if (tokenRepaired > 0 || channelIdRepaired > 0) {
        logger_1.logger.info('repairTgChainsForForwarding: done', { tokenRepaired, channelIdRepaired });
    }
    return { tokenRepaired, channelIdRepaired };
}
/** Заполняет forward_posts_since для старых связок (защита от пересылки архива getUpdates). */
async function repairTgChainForwardPostsSince() {
    await (0, adminPanelState_1.ensureAdminPanelStateLoaded)();
    const chains = await (0, adminPanelState_1.listTgChains)();
    let repaired = 0;
    for (const chain of chains) {
        if (chain.forward_posts !== true || chain.forward_posts_since?.trim()) {
            continue;
        }
        const since = chain.created_at?.trim() || new Date().toISOString();
        await (0, adminPanelState_1.updateTgChain)(chain.id, { forward_posts_since: since });
        repaired += 1;
        logger_1.logger.info('repairTgChainForwardPostsSince: set forward_posts_since from created_at', {
            chainId: chain.id,
            forwardPostsSince: since,
        });
    }
    if (repaired > 0) {
        logger_1.logger.info('repairTgChainForwardPostsSince: done', { repaired });
    }
    return repaired;
}
/** После смены токена в интеграциях — обновить цепочки со старым или пустым bot_token. */
async function syncTgChainBotTokensOnTelegramReconnect(previousToken, newToken) {
    const next = newToken.trim();
    if (!next) {
        return 0;
    }
    await (0, adminPanelState_1.ensureAdminPanelStateLoaded)();
    const prev = previousToken.trim();
    const chains = await (0, adminPanelState_1.listTgChains)();
    let updated = 0;
    for (const chain of chains) {
        const chainToken = chain.bot_token?.trim() ?? '';
        if (chainToken && chainToken !== prev) {
            continue;
        }
        if (chainToken === next) {
            continue;
        }
        await (0, adminPanelState_1.updateTgChain)(chain.id, { bot_token: next });
        updated += 1;
    }
    if (updated > 0) {
        logger_1.logger.info('syncTgChainBotTokensOnTelegramReconnect: updated chain bot_token', { updated });
    }
    return updated;
}
/** Заменить в цепочках устаревшие bot_token, если основной токен валиден. */
async function repairStaleTgChainBotTokens() {
    await (0, adminPanelState_1.ensureAdminPanelStateLoaded)();
    const mainToken = (0, resolveTelegramBotToken_1.resolveTelegramBotToken)().trim();
    if (!mainToken) {
        return { repaired: 0, checked: 0 };
    }
    if (!(await (0, telegramHealthService_1.isTelegramTokenAuthorized)(mainToken))) {
        return { repaired: 0, checked: 0 };
    }
    const chains = await (0, adminPanelState_1.listTgChains)();
    let repaired = 0;
    let checked = 0;
    for (const chain of chains) {
        const chainToken = chain.bot_token?.trim() ?? '';
        if (!chainToken || chainToken === mainToken) {
            continue;
        }
        checked += 1;
        if (await (0, telegramHealthService_1.isTelegramTokenAuthorized)(chainToken)) {
            continue;
        }
        await (0, adminPanelState_1.updateTgChain)(chain.id, { bot_token: mainToken });
        repaired += 1;
        logger_1.logger.warn('repairStaleTgChainBotTokens: replaced invalid chain bot_token', {
            chainId: chain.id,
            chainName: chain.tg_username || chain.tg_channel_id || chain.id,
        });
    }
    if (repaired > 0) {
        logger_1.logger.info('repairStaleTgChainBotTokens: done', { repaired, checked });
    }
    return { repaired, checked };
}
/** Включает forward_comments у старых miniapp-цепочек, где синхронизация была выключена по умолчанию. */
async function repairMiniappChainsForwardComments() {
    await (0, adminPanelState_1.ensureAdminPanelStateLoaded)();
    const chains = await (0, adminPanelState_1.listTgChains)();
    let repaired = 0;
    for (const chain of chains) {
        if (chain.active === false) {
            continue;
        }
        if (chain.forward_comments === true) {
            continue;
        }
        if (chain.created_via !== 'miniapp_link') {
            continue;
        }
        await (0, adminPanelState_1.updateTgChain)(chain.id, { forward_comments: true });
        repaired += 1;
        logger_1.logger.info('repairMiniappChainsForwardComments: enabled forward_comments', {
            chainId: chain.id,
            tgUsername: chain.tg_username,
        });
    }
    if (repaired > 0) {
        logger_1.logger.info('repairMiniappChainsForwardComments: done', { repaired });
    }
    return repaired;
}
//# sourceMappingURL=tgChainChannelRef.js.map