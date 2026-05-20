/**
 * Расчёт следующего запуска для периодических автопостов.
 * weekdays: 0 = воскресенье … 6 = суббота (как Date.getDay()).
 * recurring_time: "HH:MM" в локальном времени сервера.
 */
export declare function computeNextRecurringAt(recurringTime: string, weekdays: number[], from?: Date): string;
/** Из ISO datetime извлекает "HH:MM" для recurring_time. */
export declare function extractRecurringTimeFromIso(iso: string): string;
