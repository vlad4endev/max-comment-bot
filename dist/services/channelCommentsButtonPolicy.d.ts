import { type TgChainRecord } from '../api/adminPanelState';
/** Active TG→MAX chains that target this MAX channel. */
export declare function listTgChainsForMaxChannel(chatId: number): TgChainRecord[];
/**
 * Whether TG→MAX **forward** may attach the «Комментарии» button (`source: tg_chain` only).
 *
 * Native MAX posts (webhook/poller/refresh) ignore this — they use the default attach flow even if
 * the same `max_chat_id` is also a chain destination with the toggle off.
 */
export declare function isCommentsButtonEnabledForTgChainForward(chatId: number): boolean;
