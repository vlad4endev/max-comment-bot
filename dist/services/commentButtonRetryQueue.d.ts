import type { Bot } from '@maxhub/max-bot-api';
/**
 * Планирует повторную привязку кнопки (после attach_failed или пропущенного webhook).
 */
export declare function scheduleCommentButtonRetry(chatId: number, messageMid: string): void;
export declare function startCommentButtonRetryLoop(bot: Bot): void;
export declare function stopCommentButtonRetryLoop(): void;
export declare function clearCommentButtonRetriesForChannel(chatId: number): void;
export declare function getCommentButtonRetryQueueSize(): number;
