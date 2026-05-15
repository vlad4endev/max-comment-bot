"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ADMIN_PANEL_COOKIE_NAME = void 0;
exports.adminPanelCredentialsMatch = adminPanelCredentialsMatch;
exports.signAdminPanelSessionValue = signAdminPanelSessionValue;
exports.verifyAdminPanelSessionValue = verifyAdminPanelSessionValue;
exports.adminPanelSessionCookieHeader = adminPanelSessionCookieHeader;
exports.adminPanelLogoutCookieHeader = adminPanelLogoutCookieHeader;
const node_crypto_1 = require("node:crypto");
/** Имя cookie с подписанной сессией панели управления. */
exports.ADMIN_PANEL_COOKIE_NAME = 'admin_panel';
const SESSION_VERSION = 1;
/** 7 суток */
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
function secretEqual(a, b) {
    const ha = (0, node_crypto_1.createHash)('sha256').update(a, 'utf8').digest();
    const hb = (0, node_crypto_1.createHash)('sha256').update(b, 'utf8').digest();
    return (0, node_crypto_1.timingSafeEqual)(ha, hb);
}
function adminPanelCredentialsMatch(username, password, expectedUser, expectedPass) {
    return secretEqual(username, expectedUser) && secretEqual(password, expectedPass);
}
function signAdminPanelSessionValue(secret) {
    const payloadObj = { v: SESSION_VERSION, iat: Date.now() };
    const payload = Buffer.from(JSON.stringify(payloadObj), 'utf8').toString('base64url');
    const sig = (0, node_crypto_1.createHmac)('sha256', secret).update(payload).digest('base64url');
    return `${payload}.${sig}`;
}
function verifyAdminPanelSessionValue(secret, raw) {
    if (raw === null || raw === undefined || raw === '') {
        return false;
    }
    const dot = raw.indexOf('.');
    if (dot <= 0) {
        return false;
    }
    const payload = raw.slice(0, dot);
    const sig = raw.slice(dot + 1);
    const expectedSig = (0, node_crypto_1.createHmac)('sha256', secret).update(payload).digest('base64url');
    try {
        const sb = Buffer.from(sig, 'utf8');
        const eb = Buffer.from(expectedSig, 'utf8');
        if (sb.length !== eb.length) {
            return false;
        }
        if (!(0, node_crypto_1.timingSafeEqual)(sb, eb)) {
            return false;
        }
    }
    catch {
        return false;
    }
    let parsed;
    try {
        parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    }
    catch {
        return false;
    }
    if (parsed.v !== SESSION_VERSION || typeof parsed.iat !== 'number') {
        return false;
    }
    if (Date.now() - parsed.iat > SESSION_MAX_AGE_MS) {
        return false;
    }
    return true;
}
function adminPanelSessionCookieHeader(secret, maxAgeSec, secure) {
    const value = signAdminPanelSessionValue(secret);
    const parts = [
        `${exports.ADMIN_PANEL_COOKIE_NAME}=${encodeURIComponent(value)}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Strict',
        `Max-Age=${maxAgeSec}`,
    ];
    if (secure) {
        parts.push('Secure');
    }
    return parts.join('; ');
}
function adminPanelLogoutCookieHeader(secure) {
    const parts = [`${exports.ADMIN_PANEL_COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
    if (secure) {
        parts.push('Secure');
    }
    return parts.join('; ');
}
//# sourceMappingURL=adminPanelSession.js.map