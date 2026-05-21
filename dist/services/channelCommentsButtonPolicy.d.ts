import { type TgChainRecord } from '../api/adminPanelState';
/** Active TG→MAX chains that target this MAX channel. */
export declare function listTgChainsForMaxChannel(chatId: number): TgChainRecord[];
/**
 * Whether the bot may attach the «Комментарии» Mini App button for this MAX channel.
 *
 * - Channel is **not** a TG chain destination → enabled (native MAX / registry only).
 * - Channel is a chain destination → follows `add_comments_button` on **every** active chain row.
 * - `/addbutton` (`source: manual`) bypasses this check in {@link tryAttachCommentsToChannelPost}.
 */
export declare function isCommentsButtonEnabledForMaxChannel(chatId: number): boolean;
