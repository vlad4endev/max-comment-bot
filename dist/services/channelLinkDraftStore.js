"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.channelLinkDraftStore = exports.ChannelLinkDraftStore = exports.CHANNEL_LINK_DRAFT_TTL_MS = void 0;
const node_crypto_1 = require("node:crypto");
const database_1 = require("../db/database");
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
exports.CHANNEL_LINK_DRAFT_TTL_MS = 15 * 60 * 1000;
function generateLinkCode() {
    const bytes = (0, node_crypto_1.randomBytes)(6);
    let code = '';
    for (let i = 0; i < 6; i += 1) {
        code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    }
    return code;
}
function rowFromDb(raw) {
    return {
        code: String(raw.code),
        profile_id: String(raw.profile_id),
        max_chat_id: Number(raw.max_chat_id),
        max_user_id: Number(raw.max_user_id),
        max_title: typeof raw.max_title === 'string' ? raw.max_title : null,
        status: String(raw.status),
        tg_channel_id: typeof raw.tg_channel_id === 'string' ? raw.tg_channel_id : null,
        tg_username: typeof raw.tg_username === 'string' ? raw.tg_username : null,
        tg_user_id: typeof raw.tg_user_id === 'number' && Number.isInteger(raw.tg_user_id) ? raw.tg_user_id : null,
        chain_id: typeof raw.chain_id === 'string' ? raw.chain_id : null,
        forward_posts: raw.forward_posts === 0 ? false : true,
        add_comments_button: raw.add_comments_button === 0 ? false : true,
        created_at: String(raw.created_at),
        expires_at: String(raw.expires_at),
    };
}
class ChannelLinkDraftStore {
    statements = null;
    createDraft(input) {
        const stmts = this.getStatements();
        stmts.cancelOpenForMax.run(input.maxChatId);
        const expiresAt = new Date(Date.now() + exports.CHANNEL_LINK_DRAFT_TTL_MS).toISOString();
        let code = generateLinkCode();
        for (let attempt = 0; attempt < 8; attempt += 1) {
            try {
                stmts.insert.run(code, input.profileId, input.maxChatId, input.maxUserId, input.maxTitle, expiresAt);
                const row = stmts.getByCode.get(code);
                if (row) {
                    return rowFromDb(row);
                }
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                if (!msg.includes('UNIQUE constraint')) {
                    throw err;
                }
                code = generateLinkCode();
            }
        }
        throw new Error('failed to allocate link code');
    }
    getByCode(code) {
        this.expireStale();
        const normalized = String(code).trim().toUpperCase();
        if (!/^[A-Z0-9]{6}$/.test(normalized)) {
            return null;
        }
        const row = this.getStatements().getByCode.get(normalized);
        return row ? rowFromDb(row) : null;
    }
    markAwaitingMaxConfirm(code, patch) {
        this.getStatements().markAwaitingMaxConfirm.run(patch.tgChannelId, patch.tgUsername, patch.tgUserId, patch.forwardPosts ? 1 : 0, patch.addCommentsButton ? 1 : 0, code.trim().toUpperCase());
    }
    markCompleted(code, patch) {
        this.getStatements().markCompleted.run(patch.tgChannelId, patch.tgUsername, patch.tgUserId, patch.chainId, code.trim().toUpperCase());
    }
    expireStale() {
        this.getStatements().expireStale.run();
    }
    getStatements() {
        if (this.statements) {
            return this.statements;
        }
        const db = (0, database_1.getDb)();
        this.statements = {
            insert: db.prepare(`
        INSERT INTO channel_link_drafts (
          code, profile_id, max_chat_id, max_user_id, max_title, status, expires_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?)
      `),
            cancelOpenForMax: db.prepare(`
        UPDATE channel_link_drafts
        SET status = 'cancelled'
        WHERE max_chat_id = ? AND status IN ('pending', 'awaiting_max_confirm')
      `),
            getByCode: db.prepare(`
        SELECT code, profile_id, max_chat_id, max_user_id, max_title, status,
               tg_channel_id, tg_username, tg_user_id, chain_id,
               forward_posts, add_comments_button, created_at, expires_at
        FROM channel_link_drafts
        WHERE code = ?
      `),
            markAwaitingMaxConfirm: db.prepare(`
        UPDATE channel_link_drafts
        SET status = 'awaiting_max_confirm',
            tg_channel_id = ?,
            tg_username = ?,
            tg_user_id = ?,
            forward_posts = ?,
            add_comments_button = ?
        WHERE code = ?
      `),
            markCompleted: db.prepare(`
        UPDATE channel_link_drafts
        SET status = 'completed',
            tg_channel_id = ?,
            tg_username = ?,
            tg_user_id = ?,
            chain_id = ?
        WHERE code = ?
      `),
            expireStale: db.prepare(`
        UPDATE channel_link_drafts
        SET status = 'expired'
        WHERE status IN ('pending', 'awaiting_max_confirm')
          AND expires_at < datetime('now')
      `),
        };
        return this.statements;
    }
}
exports.ChannelLinkDraftStore = ChannelLinkDraftStore;
exports.channelLinkDraftStore = new ChannelLinkDraftStore();
//# sourceMappingURL=channelLinkDraftStore.js.map