"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeNextRecurringAt = computeNextRecurringAt;
exports.extractRecurringTimeFromIso = extractRecurringTimeFromIso;
/**
 * Расчёт следующего запуска для периодических автопостов.
 * weekdays: 0 = воскресенье … 6 = суббота (как Date.getDay()).
 * recurring_time: "HH:MM" в локальном времени сервера.
 */
function computeNextRecurringAt(recurringTime, weekdays, from = new Date()) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(recurringTime.trim());
    if (!match) {
        throw new Error(`invalid recurring_time: ${recurringTime}`);
    }
    const hour = Number.parseInt(match[1], 10);
    const minute = Number.parseInt(match[2], 10);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
        throw new Error(`invalid recurring_time: ${recurringTime}`);
    }
    const allowed = new Set(weekdays.filter((d) => d >= 0 && d <= 6));
    if (allowed.size === 0) {
        throw new Error('weekdays must not be empty for recurring schedule');
    }
    for (let dayOffset = 0; dayOffset <= 14; dayOffset += 1) {
        const candidate = new Date(from);
        candidate.setDate(candidate.getDate() + dayOffset);
        candidate.setHours(hour, minute, 0, 0);
        if (!allowed.has(candidate.getDay())) {
            continue;
        }
        if (candidate.getTime() > from.getTime()) {
            return candidate.toISOString();
        }
    }
    const fallback = new Date(from);
    fallback.setDate(fallback.getDate() + 7);
    fallback.setHours(hour, minute, 0, 0);
    return fallback.toISOString();
}
/** Из ISO datetime извлекает "HH:MM" для recurring_time. */
function extractRecurringTimeFromIso(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) {
        throw new Error(`invalid scheduled_at: ${iso}`);
    }
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    return `${h}:${m}`;
}
//# sourceMappingURL=autopostSchedule.js.map