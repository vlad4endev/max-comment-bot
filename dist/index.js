"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const bot_1 = require("./bot");
async function main() {
    const bot = (0, bot_1.initializeBot)();
    (0, bot_1.setupGracefulShutdown)(bot);
    await (0, bot_1.startBot)(bot);
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
//# sourceMappingURL=index.js.map