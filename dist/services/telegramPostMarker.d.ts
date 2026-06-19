/**
 * Маркировка TG-постов при кросс-платформенной брони комментариев.
 */
import type { Post } from './postStore';
/** Дописывает маркер брони к TG-посту (канал + тред обсуждения). */
export declare function applyTelegramPostBookingMarker(post: Post, marker: string): Promise<boolean>;
