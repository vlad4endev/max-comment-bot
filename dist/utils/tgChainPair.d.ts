import type { TgChainRecord } from '../api/adminPanelState';
/** Та же пара MAX + TG, что и при создании цепочки в админ-панели. */
export declare function tgChainMatchesPair(chain: TgChainRecord, maxChatId: number, tgChannelId: string | undefined, tgUsername: string): boolean;
export declare function findActiveTgChainForPair(chains: TgChainRecord[], maxChatId: number, tgChannelId: string, tgUsername: string): TgChainRecord | null;
