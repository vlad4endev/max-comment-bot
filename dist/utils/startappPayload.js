"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.encodeMessageMidForStartapp = encodeMessageMidForStartapp;
exports.decodeMessageMidFromStartapp = decodeMessageMidFromStartapp;
/** MAX startapp allows A–Z, a–z, 0–9, _, - */
function encodeMessageMidForStartapp(messageMid) {
    return Buffer.from(messageMid, 'utf8')
        .toString('base64url')
        .replace(/=/g, '');
}
function decodeMessageMidFromStartapp(encoded) {
    const trimmed = encoded.trim();
    if (!trimmed) {
        return null;
    }
    try {
        const padded = trimmed + '='.repeat((4 - (trimmed.length % 4)) % 4);
        return Buffer.from(padded, 'base64url').toString('utf8');
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=startappPayload.js.map