"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.encodeMessageMidForStartapp = encodeMessageMidForStartapp;
exports.decodeMessageMidFromStartapp = decodeMessageMidFromStartapp;
exports.compactUuidToStandard = compactUuidToStandard;
exports.parseStartappPayload = parseStartappPayload;
/** MAX startapp allows A–Z, a–z, 0–9, _, - */
const postId_1 = require("./postId");
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
/** Reconstructs standard UUID from 32-char hex (no dashes). */
function compactUuidToStandard(compact) {
    const id = compact.replace(/-/g, '').toLowerCase();
    if (!/^[a-f0-9]{32}$/.test(id)) {
        return null;
    }
    return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}
/**
 * Parses MAX `startapp` payload from button deep links (`pid_<id>_cid_<abs>[_mid_<b64url>]`).
 * `pid` segment: decimal post id or 32-char UUID hex (legacy).
 */
function parseStartappPayload(raw) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed === 'start') {
        return null;
    }
    const joinMatch = /^join(\d+)$/i.exec(trimmed);
    if (joinMatch) {
        const abs = Number.parseInt(joinMatch[1], 10);
        if (!Number.isFinite(abs) || abs <= 0) {
            return null;
        }
        return { join_channel_id: -abs };
    }
    const m = trimmed.match(/^pid_([a-f0-9]+|\d+)_cid_(\d+)(?:_mid_([A-Za-z0-9_-]+))?(_admin)?$/i);
    if (!m) {
        return null;
    }
    const post_id = (0, postId_1.parsePostIdFromStartappSegment)(m[1]);
    if (!post_id) {
        return null;
    }
    const absCid = Number.parseInt(m[2], 10);
    if (!Number.isFinite(absCid) || absCid <= 0) {
        return null;
    }
    const out = {
        post_id,
        chat_id: -absCid,
        admin: Boolean(m[4]),
    };
    if (m[3]) {
        const mid = decodeMessageMidFromStartapp(m[3]);
        if (mid) {
            out.message_mid = mid;
        }
    }
    return out;
}
//# sourceMappingURL=startappPayload.js.map