"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeNextRecurringAt = computeNextRecurringAt;
exports.extractRecurringTimeFromIso = extractRecurringTimeFromIso;
exports.isAutopostDue = isAutopostDue;
const WEEKDAY_SHORT = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
};
function zonedParts(date, timeZone) {
    const dtf = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        weekday: 'short',
    });
    const parts = Object.fromEntries(dtf.formatToParts(date).map((p) => [p.type, p.value]));
    return {
        year: Number(parts.year),
        month: Number(parts.month),
        day: Number(parts.day),
        weekday: WEEKDAY_SHORT[parts.weekday] ?? 0,
        hour: Number(parts.hour),
        minute: Number(parts.minute),
    };
}
/** Локальное время (Y-M-D H:M) в указанной IANA-зоне → UTC Date. */
function zonedLocalToUtc(year, month, day, hour, minute, timeZone) {
    let guess = Date.UTC(year, month - 1, day, hour, minute, 0);
    for (let i = 0; i < 4; i += 1) {
        const actual = zonedParts(new Date(guess), timeZone);
        const targetMs = Date.UTC(year, month - 1, day, hour, minute, 0);
        const actualMs = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, 0);
        guess += targetMs - actualMs;
    }
    return new Date(guess);
}
function addDaysInZone(base, dayOffset, timeZone) {
    const shifted = new Date(base.getTime() + dayOffset * 86_400_000);
    const parts = zonedParts(shifted, timeZone);
    return {
        year: parts.year,
        month: parts.month,
        day: parts.day,
        weekday: parts.weekday,
    };
}
/**
 * Расчёт следующего запуска для периодических автопостов.
 * weekdays: 0 = воскресенье … 6 = суббота (как Date.getDay()).
 * recurring_time: "HH:MM" в timezone (по умолчанию Europe/Moscow).
 */
function computeNextRecurringAt(recurringTime, weekdays, from = new Date(), timeZone = 'Europe/Moscow') {
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
        const local = addDaysInZone(from, dayOffset, timeZone);
        if (!allowed.has(local.weekday)) {
            continue;
        }
        const candidate = zonedLocalToUtc(local.year, local.month, local.day, hour, minute, timeZone);
        if (candidate.getTime() > from.getTime()) {
            return candidate.toISOString();
        }
    }
    const fallbackLocal = addDaysInZone(from, 7, timeZone);
    return zonedLocalToUtc(fallbackLocal.year, fallbackLocal.month, fallbackLocal.day, hour, minute, timeZone).toISOString();
}
/** Из ISO datetime извлекает "HH:MM" для recurring_time (в timezone поста). */
function extractRecurringTimeFromIso(iso, timeZone = 'Europe/Moscow') {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) {
        throw new Error(`invalid scheduled_at: ${iso}`);
    }
    const parts = zonedParts(d, timeZone);
    const h = String(parts.hour).padStart(2, '0');
    const m = String(parts.minute).padStart(2, '0');
    return `${h}:${m}`;
}
/** Проверяет, наступило ли время публикации (независимо от формата ISO-строки). */
function isAutopostDue(scheduledAt, now = new Date()) {
    const atMs = Date.parse(scheduledAt);
    if (!Number.isFinite(atMs)) {
        return false;
    }
    return atMs <= now.getTime();
}
//# sourceMappingURL=autopostSchedule.js.map