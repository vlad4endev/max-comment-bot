export declare function encodeMessageMidForStartapp(messageMid: string): string;
export declare function decodeMessageMidFromStartapp(encoded: string): string | null;
/** Reconstructs standard UUID from 32-char hex (no dashes). */
export declare function compactUuidToStandard(compact: string): string | null;
export interface ParsedStartappPayload {
    post_id?: string;
    /** Negative channel chat id (canonical for MAX channels). */
    chat_id?: number;
    message_mid?: string;
    admin?: boolean;
    join_channel_id?: number;
}
/**
 * Parses MAX `startapp` payload from button deep links (`pid_<id>_cid_<abs>[_mid_<b64url>]`).
 * `pid` segment: decimal post id or 32-char UUID hex (legacy).
 */
export declare function parseStartappPayload(raw: string): ParsedStartappPayload | null;
