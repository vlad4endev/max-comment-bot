"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WEBHOOK_CONCURRENCY = void 0;
exports.enqueueUpdate = enqueueUpdate;
const p_limit_1 = __importDefault(require("p-limit"));
/** Максимум одновременных обработок webhook-update. */
exports.WEBHOOK_CONCURRENCY = 10;
const webhookLimit = (0, p_limit_1.default)(exports.WEBHOOK_CONCURRENCY);
/**
 * Ограничивает параллелизм обработки входящих MAX updates (webhook POST).
 */
function enqueueUpdate(fn) {
    return webhookLimit(fn);
}
//# sourceMappingURL=updateQueue.js.map