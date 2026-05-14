"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.dispatchBotUpdate = dispatchBotUpdate;
async function dispatchBotUpdate(bot, update) {
    const handle = bot
        .handleUpdate;
    await handle.call(bot, update);
}
//# sourceMappingURL=dispatchUpdate.js.map