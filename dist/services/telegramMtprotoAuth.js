"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getMtprotoStatus = getMtprotoStatus;
exports.saveMtprotoCredentials = saveMtprotoCredentials;
exports.sendMtprotoLoginCode = sendMtprotoLoginCode;
exports.confirmMtprotoLoginCode = confirmMtprotoLoginCode;
exports.confirmMtprotoPassword = confirmMtprotoPassword;
exports.testMtprotoConnection = testMtprotoConnection;
exports.logoutMtprotoSession = logoutMtprotoSession;
const node_crypto_1 = require("node:crypto");
const telegram_1 = require("telegram");
const sessions_1 = require("telegram/sessions");
const logger_1 = require("../utils/logger");
const mtprotoConfigStore_1 = require("./mtprotoConfigStore");
const PENDING_TTL_MS = 15 * 60 * 1000;
const pendingLogins = new Map();
function cleanupPending() {
    const now = Date.now();
    for (const [id, p] of pendingLogins) {
        if (now - p.createdAt > PENDING_TTL_MS) {
            void p.client.disconnect().catch(() => { });
            pendingLogins.delete(id);
        }
    }
}
function requireApiCredentials() {
    const { apiId, apiHash } = (0, mtprotoConfigStore_1.resolveMtprotoCredentials)();
    if (apiId === null || !apiHash) {
        throw new Error('Укажите api_id и api_hash (my.telegram.org → API development tools)');
    }
    return { apiId, apiHash };
}
function userLabel(user) {
    if (user instanceof telegram_1.Api.User) {
        const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
        if (user.username) {
            return name ? `${name} (@${user.username})` : `@${user.username}`;
        }
        return name || `id ${user.id}`;
    }
    return 'Telegram user';
}
async function disconnectQuiet(client) {
    try {
        await client.disconnect();
    }
    catch {
        /* ignore */
    }
}
async function getMtprotoStatus() {
    const resolved = (0, mtprotoConfigStore_1.resolveMtprotoCredentials)();
    const file = (0, mtprotoConfigStore_1.readMtprotoConfigFile)();
    const hasCredentials = resolved.apiId !== null && resolved.apiHash !== '';
    const hasSession = resolved.session !== '';
    let sessionValid = null;
    let hint = null;
    if (!hasCredentials) {
        hint = 'Получите api_id и api_hash на my.telegram.org и сохраните ниже.';
    }
    else if (!hasSession) {
        hint = 'Войдите по номеру телефона — код придёт в Telegram.';
    }
    else {
        hint = 'Нажмите «Проверить подключение» перед импортом архива.';
    }
    return {
        configured: resolved.apiId !== null && resolved.apiHash !== '' && resolved.session !== '',
        has_credentials: hasCredentials,
        has_session: hasSession,
        session_valid: sessionValid,
        source: resolved.source,
        api_id: resolved.apiId,
        api_hash_set: resolved.apiHash !== '',
        phone_masked: file?.phone ? (0, mtprotoConfigStore_1.maskPhone)(file.phone) : null,
        user_display: file?.userDisplay ?? null,
        updated_at: file?.updatedAt ?? null,
        hint,
    };
}
function saveMtprotoCredentials(apiId, apiHash) {
    if (!Number.isFinite(apiId) || apiId <= 0) {
        throw new Error('api_id должен быть положительным числом');
    }
    const hash = apiHash.trim();
    if (!hash) {
        throw new Error('api_hash обязателен');
    }
    return (0, mtprotoConfigStore_1.writeMtprotoConfigFile)({ apiId, apiHash: hash });
}
async function sendMtprotoLoginCode(phoneRaw) {
    cleanupPending();
    const phone = phoneRaw.trim().replace(/\s/g, '');
    if (!phone) {
        throw new Error('Укажите номер телефона');
    }
    const { apiId, apiHash } = requireApiCredentials();
    const client = new telegram_1.TelegramClient(new sessions_1.StringSession(''), apiId, apiHash, {
        connectionRetries: 3,
    });
    await client.connect();
    try {
        const { phoneCodeHash, isCodeViaApp } = await client.sendCode({ apiId, apiHash }, phone);
        const id = (0, node_crypto_1.randomUUID)();
        pendingLogins.set(id, {
            id,
            client,
            phone,
            phoneCodeHash,
            isCodeViaApp: !!isCodeViaApp,
            apiId,
            apiHash,
            createdAt: Date.now(),
            needsPassword: false,
        });
        return {
            login_id: id,
            is_code_via_app: !!isCodeViaApp,
            phone_masked: (0, mtprotoConfigStore_1.maskPhone)(phone),
        };
    }
    catch (err) {
        await disconnectQuiet(client);
        throw err;
    }
}
async function persistSessionFromClient(client, phone, user) {
    const session = client.session.save();
    if (!session) {
        throw new Error('Не удалось сохранить сессию');
    }
    const { apiId, apiHash } = requireApiCredentials();
    (0, mtprotoConfigStore_1.writeMtprotoConfigFile)({
        apiId,
        apiHash,
        session,
        phone,
        userId: user instanceof telegram_1.Api.User ? String(user.id) : undefined,
        userDisplay: userLabel(user),
    });
}
async function confirmMtprotoLoginCode(loginId, codeRaw) {
    cleanupPending();
    const pending = pendingLogins.get(loginId);
    if (!pending) {
        throw new Error('Сессия входа истекла — запросите код заново');
    }
    const code = codeRaw.trim().replace(/\s/g, '');
    if (!code) {
        throw new Error('Введите код из Telegram');
    }
    try {
        const result = await pending.client.invoke(new telegram_1.Api.auth.SignIn({
            phoneNumber: pending.phone,
            phoneCodeHash: pending.phoneCodeHash,
            phoneCode: code,
        }));
        const user = result instanceof telegram_1.Api.auth.Authorization ? result.user : null;
        if (!user) {
            throw new Error('Неожиданный ответ Telegram при входе');
        }
        await persistSessionFromClient(pending.client, pending.phone, user);
        pendingLogins.delete(loginId);
        await disconnectQuiet(pending.client);
        return { ok: true, user_display: userLabel(user) };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const rpc = typeof err === 'object' && err !== null && 'errorMessage' in err
            ? String(err.errorMessage)
            : '';
        if (rpc === 'SESSION_PASSWORD_NEEDED' || msg.includes('SESSION_PASSWORD_NEEDED')) {
            pending.needsPassword = true;
            return { ok: false, needs_password: true, login_id: loginId };
        }
        throw err;
    }
}
async function confirmMtprotoPassword(loginId, passwordRaw) {
    cleanupPending();
    const pending = pendingLogins.get(loginId);
    if (!pending) {
        throw new Error('Сессия входа истекла — начните с отправки кода');
    }
    const password = passwordRaw;
    if (!password) {
        throw new Error('Введите пароль двухфакторной аутентификации');
    }
    try {
        const user = await pending.client.signInWithPassword({ apiId: pending.apiId, apiHash: pending.apiHash }, {
            password: async () => password,
            onError: async (e) => {
                throw e;
            },
        });
        await persistSessionFromClient(pending.client, pending.phone, user);
        pendingLogins.delete(loginId);
        await disconnectQuiet(pending.client);
        return { ok: true, user_display: userLabel(user) };
    }
    catch (err) {
        throw err;
    }
}
async function testMtprotoConnection() {
    const { apiId, apiHash, session } = (0, mtprotoConfigStore_1.resolveMtprotoCredentials)();
    if (apiId === null || !apiHash || !session) {
        throw new Error('MTProto не настроен: нужны api_id, api_hash и сессия');
    }
    const client = new telegram_1.TelegramClient(new sessions_1.StringSession(session), apiId, apiHash, {
        connectionRetries: 3,
    });
    await client.connect();
    try {
        if (!(await client.checkAuthorization())) {
            throw new Error('Сессия недействительна — войдите заново');
        }
        const me = await client.getMe();
        return { user_display: userLabel(me) };
    }
    finally {
        await disconnectQuiet(client);
    }
}
function logoutMtprotoSession() {
    (0, mtprotoConfigStore_1.clearMtprotoSession)();
    for (const [, p] of pendingLogins) {
        void disconnectQuiet(p.client);
    }
    pendingLogins.clear();
    logger_1.logger.info('[mtproto] session cleared from admin');
}
//# sourceMappingURL=telegramMtprotoAuth.js.map