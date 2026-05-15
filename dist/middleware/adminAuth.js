"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseCookieHeader = parseCookieHeader;
exports.getAdminPanelSessionFromRequest = getAdminPanelSessionFromRequest;
exports.isAdminPanelSessionValid = isAdminPanelSessionValid;
exports.checkAdminAuth = checkAdminAuth;
const config_1 = require("../config");
const adminPanelSession_1 = require("../utils/adminPanelSession");
function parseCookieHeader(header, name) {
    if (!header) {
        return null;
    }
    for (const part of header.split(';')) {
        const idx = part.indexOf('=');
        if (idx === -1) {
            continue;
        }
        const k = part.slice(0, idx).trim();
        if (k !== name) {
            continue;
        }
        return decodeURIComponent(part.slice(idx + 1).trim());
    }
    return null;
}
function getAdminPanelSessionFromRequest(req) {
    return parseCookieHeader(req.headers.cookie, adminPanelSession_1.ADMIN_PANEL_COOKIE_NAME);
}
function isAdminPanelSessionValid(req) {
    const raw = getAdminPanelSessionFromRequest(req);
    return (0, adminPanelSession_1.verifyAdminPanelSessionValue)(config_1.config.adminPanelSessionSecret, raw);
}
function checkAdminAuth(req, res, next) {
    if (!isAdminPanelSessionValid(req)) {
        res.status(403).json({ error: 'admin auth required' });
        return;
    }
    next();
}
//# sourceMappingURL=adminAuth.js.map