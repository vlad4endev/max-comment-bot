/**
 * Кросс-платформенная бронь поста: при первом комментарии на одной платформе
 * помечаем пост на MAX, Telegram и VK.
 */
import type { Bot } from '@maxhub/max-bot-api';
import type { CommentsBookedBy } from './postStore';
export declare function claimAndPropagateCommentsBooking(postId: string, by: CommentsBookedBy, bot?: Bot): Promise<boolean>;
export declare function propagateCommentsBooking(postId: string, bookedBy: CommentsBookedBy, bot?: Bot): Promise<void>;
/** Можно ли синхронизировать комментарии с платформы `from`, если пост забронирован другой платформой. */
export declare function isCommentSyncBlockedByBooking(bookedBy: CommentsBookedBy | undefined, from: CommentsBookedBy): boolean;
export declare function commentsClosedInMaxMessage(bookedBy: CommentsBookedBy | undefined): string;
