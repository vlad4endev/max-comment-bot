import type { Bot } from '@maxhub/max-bot-api';
export declare function setTgChainForwarderBot(bot: Bot): void;
export declare function getTgChainForwarderBot(): Bot | null;
export declare function runTgChainsOnce(): Promise<boolean>;
export declare function startTgChainForwarder(): void;
