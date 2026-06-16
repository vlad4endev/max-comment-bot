/**
 * tgCommentSyncService.ts
 *
 * Слушает новые сообщения из TG-треда обсуждения канала
 * и записывает их как комментарии в miniapp БД Max.
 *
 * Подключается к существующему polling-циклу tgChainForwarder.
 */
import type { Bot } from '@maxhub/max-bot-api';
import type { TgChainRecord } from '../api/adminPanelState';
import type { TgMessage } from '../forwarder/telegramReader';
export declare function isDiscussionAutoForward(message: TgMessage): boolean;
/**
 * Связывает авто-репост канала в discussion group с post_comment_mapping.
 */
export declare function handleDiscussionAutoForward(message: TgMessage, chainId: string): void;
/**
 * Комментарий в TG discussion group → комментарий в miniapp.
 */
export declare function handleTgComment(message: TgMessage, chain: TgChainRecord, bot: Bot, discussionChatId: number): Promise<void>;
