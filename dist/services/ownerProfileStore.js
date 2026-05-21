"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ownerProfileStore = exports.OwnerProfileStore = void 0;
const node_crypto_1 = require("node:crypto");
const database_1 = require("../db/database");
function isPositiveInt(value) {
    return typeof value === 'number' && Number.isInteger(value) && value > 0;
}
function normOptionalString(value) {
    if (typeof value !== 'string') {
        return null;
    }
    const t = value.trim();
    return t === '' ? null : t;
}
class OwnerProfileStore {
    statements = null;
    /** Upsert platform account and return stable profile id. */
    syncAccount(input) {
        if (!isPositiveInt(input.platformUserId)) {
            throw new Error('invalid platform user id');
        }
        const platformUserId = String(input.platformUserId);
        const stmts = this.getStatements();
        const existing = stmts.getAccount.get(input.platform, platformUserId);
        let profileId = existing?.profile_id;
        if (!profileId) {
            profileId = (0, node_crypto_1.randomUUID)();
            stmts.insertProfile.run(profileId);
        }
        else {
            stmts.touchProfile.run(profileId);
        }
        stmts.upsertAccount.run(profileId, input.platform, platformUserId, normOptionalString(input.username), normOptionalString(input.firstName), normOptionalString(input.lastName), normOptionalString(input.photoUrl));
        return profileId;
    }
    getProfileId(platform, platformUserId) {
        if (!isPositiveInt(platformUserId)) {
            return null;
        }
        const row = this.getStatements().getAccount.get(platform, String(platformUserId));
        return row?.profile_id ?? null;
    }
    getAccountsForProfile(profileId) {
        const rows = this.getStatements().listAccountsForProfile.all(profileId);
        return rows;
    }
    /** Attach TG account to the same profile as MAX (from draft). */
    attachAccountToProfile(profileId, input) {
        if (!isPositiveInt(input.platformUserId)) {
            return;
        }
        const stmts = this.getStatements();
        const platformUserId = String(input.platformUserId);
        const existing = stmts.getAccount.get(input.platform, platformUserId);
        if (existing && existing.profile_id !== profileId) {
            stmts.reassignAccountProfile.run(profileId, input.platform, platformUserId);
        }
        stmts.touchProfile.run(profileId);
        stmts.upsertAccount.run(profileId, input.platform, platformUserId, normOptionalString(input.username), normOptionalString(input.firstName), normOptionalString(input.lastName), normOptionalString(input.photoUrl));
    }
    getStatements() {
        if (this.statements) {
            return this.statements;
        }
        const db = (0, database_1.getDb)();
        this.statements = {
            insertProfile: db.prepare(`
        INSERT INTO owner_profiles (id, created_at, updated_at)
        VALUES (?, datetime('now'), datetime('now'))
      `),
            touchProfile: db.prepare(`
        UPDATE owner_profiles SET updated_at = datetime('now') WHERE id = ?
      `),
            upsertAccount: db.prepare(`
        INSERT INTO owner_profile_accounts (
          profile_id, platform, platform_user_id,
          username, first_name, last_name, photo_url, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(platform, platform_user_id) DO UPDATE SET
          profile_id = excluded.profile_id,
          username = COALESCE(excluded.username, owner_profile_accounts.username),
          first_name = COALESCE(excluded.first_name, owner_profile_accounts.first_name),
          last_name = COALESCE(excluded.last_name, owner_profile_accounts.last_name),
          photo_url = COALESCE(excluded.photo_url, owner_profile_accounts.photo_url),
          updated_at = datetime('now')
      `),
            getAccount: db.prepare(`
        SELECT profile_id FROM owner_profile_accounts
        WHERE platform = ? AND platform_user_id = ?
      `),
            listAccountsForProfile: db.prepare(`
        SELECT profile_id, platform, platform_user_id, username, first_name, last_name, photo_url, updated_at
        FROM owner_profile_accounts
        WHERE profile_id = ?
        ORDER BY platform ASC
      `),
            reassignAccountProfile: db.prepare(`
        UPDATE owner_profile_accounts SET profile_id = ?, updated_at = datetime('now')
        WHERE platform = ? AND platform_user_id = ?
      `),
        };
        return this.statements;
    }
}
exports.OwnerProfileStore = OwnerProfileStore;
exports.ownerProfileStore = new OwnerProfileStore();
//# sourceMappingURL=ownerProfileStore.js.map