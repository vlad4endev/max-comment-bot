export type OwnerPlatform = 'max' | 'telegram';
export interface OwnerAccountInput {
    platform: OwnerPlatform;
    platformUserId: number;
    username?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    photoUrl?: string | null;
}
export interface OwnerAccountRow {
    profile_id: string;
    platform: OwnerPlatform;
    platform_user_id: string;
    username: string | null;
    first_name: string | null;
    last_name: string | null;
    photo_url: string | null;
    updated_at: string;
}
export declare class OwnerProfileStore {
    private statements;
    /** Upsert platform account and return stable profile id. */
    syncAccount(input: OwnerAccountInput): string;
    getProfileId(platform: OwnerPlatform, platformUserId: number): string | null;
    getAccountsForProfile(profileId: string): OwnerAccountRow[];
    /** Attach TG account to the same profile as MAX (from draft). */
    attachAccountToProfile(profileId: string, input: OwnerAccountInput): void;
    private getStatements;
}
export declare const ownerProfileStore: OwnerProfileStore;
