import type { Bot } from '@maxhub/max-bot-api';
import type Database from 'better-sqlite3';
export declare function getDeletionWatcherStatus(): {
    active: boolean;
    mtproto_ready: boolean;
};
export declare function startTgPostDeletionWatcher(bot: Bot): void;
export declare function handleDeletedPost(db: Database.Database, chainId: string, _tgChannelId: string, tgMsgId: number): Promise<void>;
