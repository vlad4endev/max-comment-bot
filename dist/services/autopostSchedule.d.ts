/**
 * Расчёт следующего запуска для периодических автопостов.
 * weekdays: 0 = воскресенье … 6 = суббота (как Date.getDay()).
 * recurring_time: "HH:MM" в timezone (по умолчанию Europe/Moscow).
 */
export declare function computeNextRecurringAt(recurringTime: string, weekdays: number[], from?: Date, timeZone?: string): string;
/** Из ISO datetime извлекает "HH:MM" для recurring_time (в timezone поста). */
export declare function extractRecurringTimeFromIso(iso: string, timeZone?: string): string;
/** Проверяет, наступило ли время публикации (независимо от формата ISO-строки). */
export declare function isAutopostDue(scheduledAt: string, now?: Date): boolean;
