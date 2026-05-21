"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.channelSubscriberSnapshotStore = exports.ChannelSubscriberSnapshotStore = void 0;
const database_1 = require("../db/database");
const channelRegistry_1 = require("./channelRegistry");
const logger_1 = require("../utils/logger");
const PAGE_SIZE = 100;
const MAX_PAGES = 500;
function normalizeMemberName(value) {
    const t = typeof value === 'string' ? value.trim() : '';
    return t || null;
}
function normalizeMemberUsername(value) {
    const t = typeof value === 'string' ? value.trim() : '';
    return t || null;
}
function normalizeMemberAvatar(value) {
    const t = typeof value === 'string' ? value.trim() : '';
    return t || null;
}
function mapMember(channelChatId, member, syncedAtIso) {
    return {
        channel_chat_id: channelChatId,
        user_id: member.user_id,
        name: normalizeMemberName(member.name),
        username: normalizeMemberUsername(member.username),
        avatar_url: normalizeMemberAvatar(member.full_avatar_url ?? member.avatar_url),
        is_admin: member.is_admin,
        is_owner: member.is_owner,
        join_time: Number.isFinite(member.join_time) ? member.join_time : null,
        last_activity_time: Number.isFinite(member.last_activity_time) ? member.last_activity_time : null,
        synced_at: syncedAtIso,
    };
}
class ChannelSubscriberSnapshotStore {
    statements = null;
    async syncChannelSubscribers(bot, channelChatId) {
        const byUser = new Map();
        let marker;
        const syncedAtIso = new Date().toISOString();
        for (let page = 0; page < MAX_PAGES; page += 1) {
            const res = await bot.api.getChatMembers(channelChatId, {
                count: PAGE_SIZE,
                ...(marker !== undefined ? { marker } : {}),
            });
            for (const member of res.members) {
                if (member.is_bot) {
                    continue;
                }
                byUser.set(member.user_id, mapMember(channelChatId, member, syncedAtIso));
            }
            const next = res.marker;
            if (next === undefined || next === null) {
                break;
            }
            marker = next;
        }
        const tx = (0, database_1.getDb)().transaction((rows, membersTotal, syncedAt) => {
            const s = this.getStatements();
            s.deleteByChannel.run(channelChatId);
            for (const row of rows) {
                s.upsertMember.run(row.channel_chat_id, row.user_id, row.name, row.username, row.avatar_url, row.is_admin ? 1 : 0, row.is_owner ? 1 : 0, row.join_time, row.last_activity_time, syncedAt);
            }
            s.upsertSyncMeta.run(channelChatId, syncedAt, membersTotal);
        });
        tx([...byUser.values()], byUser.size, syncedAtIso);
        return { members_total: byUser.size };
    }
    async syncAllRegisteredChannels(bot) {
        const channels = channelRegistry_1.channelRegistry.getAllChannels().filter((c) => c.type === 'channel');
        const out = [];
        let synced = 0;
        let failed = 0;
        let membersTotal = 0;
        for (const ch of channels) {
            try {
                const r = await this.syncChannelSubscribers(bot, ch.chat_id);
                synced += 1;
                membersTotal += r.members_total;
                out.push({ chat_id: ch.chat_id, title: ch.title, members_total: r.members_total, ok: true });
            }
            catch (err) {
                failed += 1;
                const message = err instanceof Error ? err.message : 'failed to sync';
                logger_1.logger.warn('channelSubscriberSnapshotStore: channel sync failed', {
                    chatId: ch.chat_id,
                    err,
                });
                out.push({
                    chat_id: ch.chat_id,
                    title: ch.title,
                    members_total: 0,
                    ok: false,
                    error: message,
                });
            }
        }
        return {
            synced_channels: synced,
            failed_channels: failed,
            members_total: membersTotal,
            channels: out,
        };
    }
    listAllMembers() {
        const rows = this.getStatements().listAllMembers.all();
        return rows.map((row) => ({
            channel_chat_id: row.channel_chat_id,
            user_id: row.user_id,
            name: row.name,
            username: row.username,
            avatar_url: row.avatar_url,
            is_admin: row.is_admin === 1,
            is_owner: row.is_owner === 1,
            join_time: row.join_time,
            last_activity_time: row.last_activity_time,
            synced_at: row.synced_at,
        }));
    }
    listMembersForUser(userId) {
        const rows = this.getStatements().listMembersForUser.all(userId);
        return rows.map((row) => ({
            channel_chat_id: row.channel_chat_id,
            user_id: row.user_id,
            name: row.name,
            username: row.username,
            avatar_url: row.avatar_url,
            is_admin: row.is_admin === 1,
            is_owner: row.is_owner === 1,
            join_time: row.join_time,
            last_activity_time: row.last_activity_time,
            synced_at: row.synced_at,
        }));
    }
    listChannelSyncMeta() {
        const db = (0, database_1.getDb)();
        const rows = db
            .prepare(`SELECT channel_chat_id, last_synced_at, members_total
         FROM channel_subscribers_sync
         ORDER BY channel_chat_id ASC`)
            .all();
        return rows;
    }
    getStatements() {
        if (this.statements) {
            return this.statements;
        }
        const db = (0, database_1.getDb)();
        this.statements = {
            deleteByChannel: db.prepare('DELETE FROM channel_subscribers WHERE channel_chat_id = ?'),
            upsertMember: db.prepare(`
        INSERT OR REPLACE INTO channel_subscribers (
          channel_chat_id,
          user_id,
          name,
          username,
          avatar_url,
          is_admin,
          is_owner,
          join_time,
          last_activity_time,
          synced_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
            upsertSyncMeta: db.prepare(`
        INSERT OR REPLACE INTO channel_subscribers_sync (
          channel_chat_id,
          last_synced_at,
          members_total
        ) VALUES (?, ?, ?)
      `),
            listAllMembers: db.prepare(`
        SELECT
          channel_chat_id,
          user_id,
          name,
          username,
          avatar_url,
          is_admin,
          is_owner,
          join_time,
          last_activity_time,
          synced_at
        FROM channel_subscribers
        ORDER BY user_id ASC, channel_chat_id ASC
      `),
            listMembersForUser: db.prepare(`
        SELECT
          channel_chat_id,
          user_id,
          name,
          username,
          avatar_url,
          is_admin,
          is_owner,
          join_time,
          last_activity_time,
          synced_at
        FROM channel_subscribers
        WHERE user_id = ?
        ORDER BY channel_chat_id ASC
      `),
        };
        return this.statements;
    }
}
exports.ChannelSubscriberSnapshotStore = ChannelSubscriberSnapshotStore;
exports.channelSubscriberSnapshotStore = new ChannelSubscriberSnapshotStore();
//# sourceMappingURL=channelSubscriberSnapshotStore.js.map