"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setTelegramTgChainLifecycleBot = setTelegramTgChainLifecycleBot;
exports.pauseTgChainsForTelegramChannelLostAdmin = pauseTgChainsForTelegramChannelLostAdmin;
exports.restoreTgChainsForTelegramChannelAdminRestored = restoreTgChainsForTelegramChannelAdminRestored;
const adminPanelState_1 = require("../api/adminPanelState");
const notificationService_1 = require("./notificationService");
const logger_1 = require("../utils/logger");
let maxBotRef = null;
function setTelegramTgChainLifecycleBot(bot) {
    maxBotRef = bot;
}
function formatTelegramChannelLabel(title, username) {
    const displayTitle = title?.trim() || 'Telegram-канал';
    const uname = username?.trim();
    if (uname) {
        const handle = uname.startsWith('@') ? uname : `@${uname}`;
        return `«${displayTitle}» (${handle})`;
    }
    return `«${displayTitle}»`;
}
function findChainsForTelegramChannel(tgChannelChatId, tgUsername) {
    const chatId = String(tgChannelChatId).trim();
    const unameKey = (tgUsername ?? '').trim().replace(/^@/, '').toLowerCase();
    return (0, adminPanelState_1.listTgChainsSync)().filter((chain) => {
        const chainId = chain.tg_channel_id?.trim();
        if (chainId && chainId === chatId) {
            return true;
        }
        if (!chainId && unameKey) {
            return chain.tg_username.trim().replace(/^@/, '').toLowerCase() === unameKey;
        }
        return false;
    });
}
function formatMaxChannelLabel(chain) {
    return chain.max_title?.trim() ? `«${chain.max_title.trim()}»` : `канал MAX (${chain.max_chat_id})`;
}
/**
 * Бот потерял права администратора в TG-канале: приостанавливаем связки и уведомляем админов MAX.
 */
async function pauseTgChainsForTelegramChannelLostAdmin(input) {
    await (0, adminPanelState_1.ensureAdminPanelStateLoaded)();
    const chains = findChainsForTelegramChannel(input.tgChannelChatId, input.tgUsername);
    const toPause = chains.filter((c) => c.active !== false);
    if (toPause.length === 0) {
        return { pausedChainIds: [] };
    }
    const pausedAt = new Date().toISOString();
    const pausedChainIds = [];
    for (const chain of toPause) {
        await (0, adminPanelState_1.updateTgChain)(chain.id, { active: false, auto_paused_at: pausedAt });
        pausedChainIds.push(chain.id);
        logger_1.logger.info('telegramTgChainLifecycle: chain auto-paused', {
            chainId: chain.id,
            tgChannelChatId: input.tgChannelChatId,
            maxChatId: chain.max_chat_id,
        });
    }
    const bot = maxBotRef;
    if (!bot) {
        logger_1.logger.warn('telegramTgChainLifecycle: MAX bot not set, skip lost-admin notify');
        return { pausedChainIds };
    }
    const tgLabel = formatTelegramChannelLabel(input.tgTitle, input.tgUsername);
    const notifiedMax = new Set();
    for (const chain of toPause) {
        if (notifiedMax.has(chain.max_chat_id)) {
            continue;
        }
        notifiedMax.add(chain.max_chat_id);
        const maxLabel = formatMaxChannelLabel(chain);
        const text = `⚠️ Связка с Telegram прервана\n\n` +
            `Канал в Telegram: ${tgLabel}\n` +
            `Связка с MAX ${maxLabel} приостановлена: бот потерял права администратора в Telegram-канале. ` +
            `Пересылка постов из Telegram в MAX временно остановлена.\n\n` +
            `Чтобы восстановить: снова назначьте @commentvmax_bot администратором в Telegram-канале ` +
            `и нажмите «Подтвердить подключение» в личке с ботом.`;
        try {
            await (0, notificationService_1.notifyAllAdmins)(bot, chain.max_chat_id, text);
        }
        catch (err) {
            logger_1.logger.warn('telegramTgChainLifecycle: notify MAX lost link failed', {
                maxChatId: chain.max_chat_id,
                chainId: chain.id,
                err,
            });
        }
    }
    return { pausedChainIds };
}
/**
 * Права администратора в TG восстановлены: возобновляем автоприостановленные связки и уведомляем MAX.
 */
async function restoreTgChainsForTelegramChannelAdminRestored(input) {
    await (0, adminPanelState_1.ensureAdminPanelStateLoaded)();
    const chains = findChainsForTelegramChannel(input.tgChannelChatId, input.tgUsername);
    const toRestore = chains.filter((c) => typeof c.auto_paused_at === 'string' && c.auto_paused_at.trim() !== '');
    if (toRestore.length === 0) {
        return { restoredChainIds: [] };
    }
    const restoredChainIds = [];
    for (const chain of toRestore) {
        await (0, adminPanelState_1.updateTgChain)(chain.id, { active: true, auto_paused_at: null });
        restoredChainIds.push(chain.id);
        logger_1.logger.info('telegramTgChainLifecycle: chain auto-restored', {
            chainId: chain.id,
            tgChannelChatId: input.tgChannelChatId,
            maxChatId: chain.max_chat_id,
        });
    }
    const bot = maxBotRef;
    if (!bot) {
        logger_1.logger.warn('telegramTgChainLifecycle: MAX bot not set, skip restored notify');
        return { restoredChainIds };
    }
    const tgLabel = formatTelegramChannelLabel(input.tgTitle, input.tgUsername);
    const notifiedMax = new Set();
    for (const chain of toRestore) {
        if (notifiedMax.has(chain.max_chat_id)) {
            continue;
        }
        notifiedMax.add(chain.max_chat_id);
        const maxLabel = formatMaxChannelLabel(chain);
        const text = `✅ Связка с Telegram восстановлена\n\n` +
            `Канал в Telegram: ${tgLabel}\n` +
            `Связка с MAX ${maxLabel} снова активна — пересылка постов из Telegram возобновлена.`;
        try {
            await (0, notificationService_1.notifyAllAdmins)(bot, chain.max_chat_id, text);
        }
        catch (err) {
            logger_1.logger.warn('telegramTgChainLifecycle: notify MAX restored link failed', {
                maxChatId: chain.max_chat_id,
                chainId: chain.id,
                err,
            });
        }
    }
    return { restoredChainIds };
}
//# sourceMappingURL=telegramTgChainLifecycle.js.map