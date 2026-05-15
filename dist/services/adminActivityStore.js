"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pushAdminActivity = pushAdminActivity;
exports.getRecentAdminActivity = getRecentAdminActivity;
const MAX_EVENTS = 100;
const events = [];
function pushAdminActivity(type, payload = {}) {
    events.unshift({
        type,
        timestamp: new Date().toISOString(),
        payload,
    });
    if (events.length > MAX_EVENTS) {
        events.length = MAX_EVENTS;
    }
}
function getRecentAdminActivity(limit) {
    const n = Math.min(Math.max(0, limit), events.length);
    return events.slice(0, n);
}
//# sourceMappingURL=adminActivityStore.js.map