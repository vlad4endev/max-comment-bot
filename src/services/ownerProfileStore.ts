import { randomUUID } from 'node:crypto'

import type Database from 'better-sqlite3'

import { getDb } from '../db/database'

export type OwnerPlatform = 'max' | 'telegram'

export interface OwnerAccountInput {
  platform: OwnerPlatform
  platformUserId: number
  username?: string | null
  firstName?: string | null
  lastName?: string | null
  photoUrl?: string | null
}

export interface OwnerAccountRow {
  profile_id: string
  platform: OwnerPlatform
  platform_user_id: string
  username: string | null
  first_name: string | null
  last_name: string | null
  photo_url: string | null
  updated_at: string
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function normOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const t = value.trim()
  return t === '' ? null : t
}

export class OwnerProfileStore {
  private statements:
    | {
        insertProfile: Database.Statement
        touchProfile: Database.Statement
        upsertAccount: Database.Statement
        getAccount: Database.Statement
        listAccountsForProfile: Database.Statement
        reassignAccountProfile: Database.Statement
      }
    | null = null

  /** Upsert platform account and return stable profile id. */
  syncAccount(input: OwnerAccountInput): string {
    if (!isPositiveInt(input.platformUserId)) {
      throw new Error('invalid platform user id')
    }
    const platformUserId = String(input.platformUserId)
    const stmts = this.getStatements()
    const existing = stmts.getAccount.get(input.platform, platformUserId) as
      | { profile_id: string }
      | undefined

    let profileId = existing?.profile_id
    if (!profileId) {
      profileId = randomUUID()
      stmts.insertProfile.run(profileId)
    } else {
      stmts.touchProfile.run(profileId)
    }

    stmts.upsertAccount.run(
      profileId,
      input.platform,
      platformUserId,
      normOptionalString(input.username),
      normOptionalString(input.firstName),
      normOptionalString(input.lastName),
      normOptionalString(input.photoUrl),
    )
    return profileId
  }

  getProfileId(platform: OwnerPlatform, platformUserId: number): string | null {
    if (!isPositiveInt(platformUserId)) {
      return null
    }
    const row = this.getStatements().getAccount.get(platform, String(platformUserId)) as
      | { profile_id: string }
      | undefined
    return row?.profile_id ?? null
  }

  getAccountsForProfile(profileId: string): OwnerAccountRow[] {
    const rows = this.getStatements().listAccountsForProfile.all(profileId) as Array<{
      profile_id: string
      platform: OwnerPlatform
      platform_user_id: string
      username: string | null
      first_name: string | null
      last_name: string | null
      photo_url: string | null
      updated_at: string
    }>
    return rows
  }

  /** Attach TG account to the same profile as MAX (from draft). */
  attachAccountToProfile(profileId: string, input: OwnerAccountInput): void {
    if (!isPositiveInt(input.platformUserId)) {
      return
    }
    const stmts = this.getStatements()
    const platformUserId = String(input.platformUserId)
    const existing = stmts.getAccount.get(input.platform, platformUserId) as
      | { profile_id: string }
      | undefined
    if (existing && existing.profile_id !== profileId) {
      stmts.reassignAccountProfile.run(profileId, input.platform, platformUserId)
    }
    stmts.touchProfile.run(profileId)
    stmts.upsertAccount.run(
      profileId,
      input.platform,
      platformUserId,
      normOptionalString(input.username),
      normOptionalString(input.firstName),
      normOptionalString(input.lastName),
      normOptionalString(input.photoUrl),
    )
  }

  private getStatements(): NonNullable<OwnerProfileStore['statements']> {
    if (this.statements) {
      return this.statements
    }
    const db = getDb()
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
    }
    return this.statements
  }
}

export const ownerProfileStore = new OwnerProfileStore()
