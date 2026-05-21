import type { Bot } from '@maxhub/max-bot-api';
import { type TgChainRecord } from '../api/adminPanelState';
export interface ChannelLinkAdminTeamMemberWire {
    profile_id: string;
    display_name: string;
    username: string | null;
    max_user_id: number | null;
    tg_user_id: number | null;
    paired: boolean;
}
export declare function profilePairingForPlatformUser(platform: 'max' | 'telegram', userId: number): {
    paired: boolean;
    max_user_id: number | null;
    tg_user_id: number | null;
};
export interface ChannelLinkAdminTeamSyncResult {
    chain_id: string;
    tg_title: string;
    max_title: string | null;
    paired_count: number;
    max_only_count: number;
    tg_only_count: number;
    members: ChannelLinkAdminTeamMemberWire[];
}
export declare function syncChannelLinkAdminTeam(bot: Bot, tgToken: string, input: {
    chainId: string;
    actorMaxUserId?: number;
    actorTgUserId?: number;
}): Promise<ChannelLinkAdminTeamSyncResult>;
export declare function syncAllChannelLinkAdminTeamsForUser(bot: Bot, tgToken: string, input: {
    chains: TgChainRecord[];
    actorMaxUserId?: number;
    actorTgUserId?: number;
}): Promise<ChannelLinkAdminTeamSyncResult[]>;
