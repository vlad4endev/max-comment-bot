"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerEventHandlers = registerEventHandlers;
const max_bot_api_1 = require("@maxhub/max-bot-api");
const uuid_1 = require("uuid");
const config_1 = require("../config");
const channelRegistry_1 = require("../services/channelRegistry");
const commentStore_1 = require("../services/commentStore");
const notificationService_1 = require("../services/notificationService");
const postStore_1 = require("../services/postStore");
const stateManager_1 = require("../services/stateManager");
const logger_1 = require("../utils/logger");
/** Welcome copy for first-time private `bot_started` without a deeplink payload. */
const ONBOARDING_WELCOME_TEXT = `👋 Hello! I'm the comment bot.

To connect your channel:
1. Add me to your channel
2. Grant me admin rights
3. Come back here — I'll confirm automatically`;
const ONBOARDING_WELCOME_KEYBOARD = max_bot_api_1.Keyboard.inlineKeyboard([
    [max_bot_api_1.Keyboard.button.link('📖 How to add bot to channel', 'https://help.max.ru')],
]);
/**
 * Определяет идентификатор чата для входящего сообщения (группа/канал/диалог).
 * Если `recipient.chat_id` отсутствует, используется id пользователя как запасной ключ для 1:1.
 */
function resolveMessageChatId(message, fallbackUserId) {
    const rid = message.recipient.chat_id;
    if (typeof rid === 'number' && Number.isFinite(rid)) {
        return rid;
    }
    return fallbackUserId;
}
/**
 * Подтягивает тип чата из флага `is_channel`, если запрос метаданных чата не удался.
 */
function fallbackChatType(isChannel) {
    return isChannel ? 'channel' : 'chat';
}
/**
 * Channel posts should have `recipient.chat_type === 'channel'`, but if MAX sends another value,
 * we confirm via {@link Bot.api.getChat} so posts are not skipped.
 */
async function isLikelyChannelPost(bot, message) {
    if (message.recipient.chat_type === 'channel') {
        return true;
    }
    const rid = message.recipient.chat_id;
    if (typeof rid !== 'number' || !Number.isFinite(rid)) {
        return false;
    }
    try {
        const chat = await bot.api.getChat(rid);
        return chat.type === 'channel';
    }
    catch (err) {
        logger_1.logger.debug('isLikelyChannelPost: getChat failed', { rid, err });
        return false;
    }
}
/**
 * Sends a DM by user id; logs and ignores failures (user blocked the bot or never pressed Start).
 */
async function trySendDmToUser(bot, userId, text, extra) {
    try {
        await bot.api.sendMessageToUser(userId, text, extra);
    }
    catch (err) {
        logger_1.logger.warn('trySendDmToUser: could not deliver private message', { userId, err });
    }
}
/**
 * Loads the bot's own {@link ChatMember} row in a chat via `GET chats/{id}/members/me`.
 */
async function fetchBotChatMember(bot, channelChatId) {
    try {
        return await bot.api.getChatMembership(channelChatId);
    }
    catch (err) {
        logger_1.logger.warn('fetchBotChatMember: API error', { channelChatId, err });
        return null;
    }
}
/** Whether the bot is allowed to moderate the channel (admin or owner). */
function isBotAdminOrOwner(member) {
    return member.is_admin || member.is_owner;
}
async function fetchChatTitle(bot, channelChatId) {
    try {
        const chat = await bot.api.getChat(channelChatId);
        return chat.title ?? null;
    }
    catch {
        return null;
    }
}
async function fetchChatType(bot, channelChatId) {
    try {
        const chat = await bot.api.getChat(channelChatId);
        return chat.type;
    }
    catch {
        return null;
    }
}
function firstImageUrlFromMessage(message) {
    const list = message.body.attachments;
    if (!list || list.length === 0) {
        return undefined;
    }
    for (const att of list) {
        if (att.type === 'image' && typeof att.payload.url === 'string' && att.payload.url.length > 0) {
            return att.payload.url;
        }
    }
    return undefined;
}
/**
 * Проверяет, что пользователь — админ или владелец канала (не бот).
 */
async function isUserChannelAdmin(bot, channelChatId, userId) {
    try {
        const { members } = await bot.api.getChatMembers(channelChatId, { user_ids: [userId] });
        const m = members[0];
        if (!m) {
            return false;
        }
        return !m.is_bot && (m.is_admin || m.is_owner);
    }
    catch (err) {
        logger_1.logger.warn('isUserChannelAdmin: API error', { channelChatId, userId, err });
        return false;
    }
}
/**
 * Обрабатывает новый пост в канале: сохраняет пост и вешает кнопку Mini App.
 */
async function handleChannelAdminPost(bot, ctx, message, user) {
    const chatId = resolveMessageChatId(message, user.user_id);
    logger_1.logger.info('handleChannelAdminPost: start', {
        chatId,
        senderId: user.user_id,
        recipientChatType: message.recipient.chat_type,
        messageMid: message.body.mid,
    });
    const botNumericId = ctx.myId;
    if (botNumericId !== undefined && user.user_id === botNumericId) {
        logger_1.logger.debug('handleChannelAdminPost: skip (sender is bot)');
        return;
    }
    const miniBase = config_1.config.miniAppUrl;
    if (!miniBase) {
        logger_1.logger.debug('handleChannelAdminPost: MINI_APP_URL не задан, пропуск');
        return;
    }
    const adminOk = await isUserChannelAdmin(bot, chatId, user.user_id);
    if (!adminOk) {
        logger_1.logger.info('handleChannelAdminPost: skip (user is not channel admin/owner)', {
            chatId,
            userId: user.user_id,
        });
        return;
    }
    const postId = (0, uuid_1.v4)();
    const text = message.body.text?.trim() ?? '';
    const photoUrl = firstImageUrlFromMessage(message);
    const post = {
        post_id: postId,
        chat_id: chatId,
        message_mid: message.body.mid,
        text,
        photo_url: photoUrl,
        comment_count: 0,
        timestamp: new Date().toISOString(),
    };
    postStore_1.postStore.savePost(post);
    const openUrl = (0, postStore_1.buildMiniAppUrl)(miniBase, postId, chatId);
    const kb = max_bot_api_1.Keyboard.inlineKeyboard([[max_bot_api_1.Keyboard.button.link('💬 Комментарии (0)', openUrl)]]);
    const editText = text === '' ? '\u00a0' : text;
    await (0, postStore_1.attachCommentButtonToChannelPost)(bot, post, editText, kb);
}
/**
 * Resolves who should receive onboarding DMs: for `bot_added` this is `ctx.user` (who added the bot);
 * for `user_added` (self) use `inviter_id` only — `ctx.user` is the bot, not a human recipient.
 */
function resolveInviterUserId(updateType, addedByUserFromContext, inviterId) {
    if (updateType === 'bot_added') {
        const id = addedByUserFromContext?.user_id;
        if (typeof id === 'number' && Number.isInteger(id) && id > 0) {
            return id;
        }
        return undefined;
    }
    if (updateType === 'user_added') {
        if (typeof inviterId === 'number' && Number.isInteger(inviterId) && inviterId > 0) {
            return inviterId;
        }
        return undefined;
    }
    return undefined;
}
/**
 * Parses `/connect` with optional positive integer channel id.
 * Returns `false` when the message is not this command, or `undefined` when the argument is invalid.
 */
function parseConnectCommand(text) {
    const t = text.trim();
    if (!/^\/connect\b/i.test(t)) {
        return false;
    }
    const rest = t.replace(/^\/connect\b/i, '').trim();
    if (rest === '') {
        return { mode: 'all' };
    }
    const channelId = Number.parseInt(rest, 10);
    if (!Number.isInteger(channelId) || channelId <= 0) {
        return undefined;
    }
    return { mode: 'one', channelId };
}
/**
 * Verifies admin/owner rights, registers the channel when allowed, and maintains pending state otherwise.
 */
async function tryActivateChannelRegistration(ctx, bot, channelChatId, isChannel) {
    const member = await fetchBotChatMember(bot, channelChatId);
    if (!member) {
        stateManager_1.stateManager.markChannelPendingAdminRights(channelChatId);
        return { status: 'pending', shouldNotifyMissingAdmin: false };
    }
    if (!isBotAdminOrOwner(member)) {
        stateManager_1.stateManager.markChannelPendingAdminRights(channelChatId);
        return { status: 'pending', shouldNotifyMissingAdmin: true };
    }
    stateManager_1.stateManager.clearChannelPendingAdminRights(channelChatId);
    if (channelRegistry_1.channelRegistry.getChannel(channelChatId) !== null) {
        return { status: 'already_registered' };
    }
    await registerChannelOnBotJoin(ctx, bot, channelChatId, isChannel);
    return { status: 'registered' };
}
async function dmInviterAboutMissingAdmin(bot, inviterUserId, channelChatId, channelTitle) {
    const title = channelTitle ?? '—';
    const text = `⚠️ I was added to "${title}" but I need admin rights to work.

Please grant me admin rights, then I'll connect automatically.

If nothing happens, open this chat and send: /connect ${channelChatId}`;
    if (inviterUserId !== undefined) {
        await trySendDmToUser(bot, inviterUserId, text);
        return;
    }
    logger_1.logger.warn('dmInviterAboutMissingAdmin: no inviter user id; skipping DM', { channelChatId });
}
/**
 * Регистрирует чат при появлении бота и шлёт уведомление администратору.
 */
async function registerChannelOnBotJoin(ctx, bot, chatId, isChannel) {
    stateManager_1.stateManager.clearChannelPendingAdminRights(chatId);
    try {
        const chat = await ctx.getChat(chatId);
        channelRegistry_1.channelRegistry.saveChannel(chatId, { title: chat.title, type: chat.type });
        await (0, notificationService_1.notifyAllAdmins)(bot, chatId, `✅ Bot added to channel: ${chat.title ?? '—'} (ID: ${chatId})`);
    }
    catch (e) {
        logger_1.logger.error('registerChannelOnBotJoin: не удалось получить чат через API', e);
        channelRegistry_1.channelRegistry.saveChannel(chatId, {
            title: null,
            type: fallbackChatType(isChannel),
        });
        await (0, notificationService_1.notifyAllAdmins)(bot, chatId, `✅ Bot added to channel: — (ID: ${chatId})`);
    }
}
/**
 * Удаляет чат из реестра и уведомляет администратора (один раз, если запись была).
 */
async function unregisterChannelOnBotLeave(bot, chatId) {
    stateManager_1.stateManager.clearChannelPendingAdminRights(chatId);
    const removed = channelRegistry_1.channelRegistry.removeChannel(chatId);
    if (!removed) {
        return;
    }
    await (0, notificationService_1.notifyAllAdmins)(bot, chatId, `❌ Bot removed from channel: ${removed.title ?? '—'} (ID: ${chatId})`);
}
function registerEventHandlers(bot) {
    bot.on('bot_added', async (ctx) => {
        const { chat_id: channelChatId, is_channel: isChannel } = ctx.update;
        logger_1.logger.info(`bot_added: chat_id=${channelChatId}`);
        const outcome = await tryActivateChannelRegistration(ctx, bot, channelChatId, isChannel);
        if (outcome.status === 'pending' && outcome.shouldNotifyMissingAdmin) {
            const inviter = resolveInviterUserId(ctx.update.update_type, ctx.user, undefined);
            const title = await fetchChatTitle(bot, channelChatId);
            await dmInviterAboutMissingAdmin(bot, inviter, channelChatId, title);
        }
    });
    bot.on('bot_removed', async (ctx) => {
        const { chat_id } = ctx.update;
        logger_1.logger.info(`bot_removed: chat_id=${chat_id}`);
        await unregisterChannelOnBotLeave(bot, chat_id);
    });
    /**
     * MAX использует `user_added`, когда участник вступает в чат.
     * Если участник — сам бот, обрабатываем как подключение к каналу (на случай, если `bot_added` не пришёл).
     */
    bot.on('user_added', async (ctx) => {
        const { chat_id: channelChatId, is_channel: isChannel, inviter_id: inviterId } = ctx.update;
        const addedUserId = ctx.user?.user_id;
        const botNumericId = ctx.myId;
        if (addedUserId === undefined ||
            botNumericId === undefined ||
            addedUserId !== botNumericId) {
            return;
        }
        if (channelRegistry_1.channelRegistry.getChannel(channelChatId) !== null) {
            return;
        }
        logger_1.logger.info(`user_added (self): chat_id=${channelChatId}`);
        const outcome = await tryActivateChannelRegistration(ctx, bot, channelChatId, isChannel);
        if (outcome.status === 'pending' && outcome.shouldNotifyMissingAdmin) {
            const inviter = resolveInviterUserId(ctx.update.update_type, ctx.user, inviterId);
            const title = await fetchChatTitle(bot, channelChatId);
            await dmInviterAboutMissingAdmin(bot, inviter, channelChatId, title);
        }
    });
    /**
     * Аналогично `user_removed`: если удалили бота, дублируем логику `bot_removed`, если событие одно из двух.
     */
    bot.on('user_removed', async (ctx) => {
        const { chat_id } = ctx.update;
        const removedUserId = ctx.user?.user_id;
        const botNumericId = ctx.myId;
        if (removedUserId === undefined ||
            botNumericId === undefined ||
            removedUserId !== botNumericId) {
            return;
        }
        logger_1.logger.info(`user_removed (self): chat_id=${chat_id}`);
        await unregisterChannelOnBotLeave(bot, chat_id);
    });
    bot.on('bot_started', async (ctx) => {
        const user = ctx.user;
        if (!user) {
            return;
        }
        const chatId = ctx.chatId;
        if (chatId === undefined) {
            logger_1.logger.warn('bot_started: нет chat_id в контексте');
            return;
        }
        stateManager_1.stateManager.setUserPrivateChatId(user.user_id, chatId);
        logger_1.logger.info(`bot_started: пользователь ${user.user_id}, chat ${chatId}`);
        await ctx.reply(ONBOARDING_WELCOME_TEXT, {
            attachments: [ONBOARDING_WELCOME_KEYBOARD],
        });
    });
    bot.on('message_created', async (ctx) => {
        const message = ctx.message;
        if (!message) {
            return;
        }
        const user = message.sender;
        if (!user) {
            return;
        }
        const chatId = resolveMessageChatId(message, user.user_id);
        logger_1.logger.info(`message_created: от ${user.user_id} в чате ${chatId}`);
        const channelLikely = await isLikelyChannelPost(bot, message);
        if (channelLikely) {
            logger_1.logger.info('message_created: treating as channel post', {
                chatId,
                recipientChatType: message.recipient.chat_type,
                messageMid: message.body.mid,
            });
            logger_1.logger.info('message_created: full message JSON', { json: JSON.stringify(message) });
            await handleChannelAdminPost(bot, ctx, message, user);
            return;
        }
        const text = message.body.text?.trim() ?? '';
        const parsedConnect = parseConnectCommand(text);
        if (parsedConnect === undefined) {
            await ctx.reply('Usage: /connect  or  /connect <channel_id>');
            return;
        }
        if (parsedConnect !== false) {
            let currentChat;
            try {
                currentChat = await ctx.api.getChat(chatId);
            }
            catch (err) {
                logger_1.logger.warn('message_created /connect: getChat failed', { chatId, err });
                await ctx.reply('Could not load this chat. Try again later.');
                return;
            }
            if (currentChat.type !== 'dialog') {
                await ctx.reply('/connect works only in a private chat with the bot.');
                return;
            }
            const targets = parsedConnect.mode === 'one'
                ? [parsedConnect.channelId]
                : stateManager_1.stateManager.getPendingAdminChannelIds();
            if (targets.length === 0) {
                await ctx.reply('No channels are waiting for admin rights. Add the bot to a channel first.');
                return;
            }
            const lines = [];
            for (const channelChatId of targets) {
                const chatType = await fetchChatType(bot, channelChatId);
                const isChannelFlag = chatType === null ? true : chatType === 'channel';
                const outcome = await tryActivateChannelRegistration(ctx, bot, channelChatId, isChannelFlag);
                if (outcome.status === 'registered') {
                    lines.push(`✅ Channel ${channelChatId}: connected.`);
                }
                else if (outcome.status === 'already_registered') {
                    lines.push(`ℹ️ Channel ${channelChatId}: already connected.`);
                }
                else if (outcome.status === 'pending') {
                    lines.push(`⏳ Channel ${channelChatId}: still not admin, or API could not verify membership. Grant admin rights and run /connect again.`);
                }
            }
            await ctx.reply(lines.join('\n'));
            return;
        }
        if (text === '/status') {
            const reg = channelRegistry_1.channelRegistry.getChannel(chatId);
            const states = stateManager_1.stateManager.countStatesInChat(chatId);
            const postIds = new Set(postStore_1.postStore.getPostsByChatId(chatId).map((p) => p.post_id));
            const comments = commentStore_1.commentStore.countForPostIds(postIds);
            const title = reg?.title ?? '—';
            const type = reg?.type ?? '—';
            const inRegistry = reg !== null ? 'да' : 'нет';
            const added = reg?.date_added ?? '—';
            await ctx.reply(`📊 Текущий чат\nID: ${chatId}\nНазвание: ${title}\nТип: ${type}\nВ реестре: ${inRegistry}\nДата добавления в реестр: ${added}\nАктивных сессий (состояний): ${states}\nКомментариев из этого чата: ${comments}`);
            return;
        }
        if (text === '/channels') {
            if (chatId !== config_1.config.ADMIN_CHAT_ID) {
                await ctx.reply('Команда /channels доступна только из админского чата.');
                return;
            }
            const all = channelRegistry_1.channelRegistry.getAllChannels();
            if (all.length === 0) {
                await ctx.reply('Подключённых каналов пока нет.');
                return;
            }
            const lines = all.map((c) => `• ${c.title ?? '—'} — ID ${c.chat_id} (${c.type}), с ${c.date_added}`);
            await ctx.reply(`Подключённые каналы (${all.length}):\n${lines.join('\n')}`);
            return;
        }
        const state = stateManager_1.stateManager.getState(chatId, user.user_id);
        if (!state) {
            await ctx.reply('👋 Откройте мини-приложение по кнопке «Комментарии» под постом в канале.');
            return;
        }
        await ctx.reply('Сессия устарела. Откройте комментарии снова из канала.');
        stateManager_1.stateManager.deleteState(chatId, user.user_id);
    });
    logger_1.logger.info('✅ Обработчики событий зарегистрированы');
}
//# sourceMappingURL=events.js.map