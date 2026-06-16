/**
 * telegramThreadReplySync.ts
 *
 * Ответ администратора в Max miniapp → сообщение в TG discussion group.
 */
import type { Bot } from '@maxhub/max-bot-api';
import type { Comment } from './commentStore';
import type { Post } from './postStore';
/**
 * Отправляет последний ответ администратора в TG-тред, если есть маппинг поста.
 */
export declare function syncAdminReplyToTelegramThread(_bot: Bot, comment: Comment, post: Post): Promise<void>;
