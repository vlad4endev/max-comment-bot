"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildConfirmChannelLinkPayload = buildConfirmChannelLinkPayload;
exports.parseConfirmChannelLinkPayload = parseConfirmChannelLinkPayload;
/** MAX inline callback: подтвердить связку TG ↔ MAX по коду черновика. */
function buildConfirmChannelLinkPayload(code) {
    const normalized = String(code).trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(normalized)) {
        throw new Error('buildConfirmChannelLinkPayload: invalid code');
    }
    return `confirm_link_${normalized}`;
}
function parseConfirmChannelLinkPayload(raw) {
    const m = /^confirm_link_([A-Z0-9]{6})$/i.exec(String(raw || '').trim());
    if (!m) {
        return null;
    }
    return m[1].toUpperCase();
}
//# sourceMappingURL=channelLinkCallback.js.map