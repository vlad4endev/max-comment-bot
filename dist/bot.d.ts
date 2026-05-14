import { Bot } from '@maxhub/max-bot-api';
declare function initializeBot(): Bot;
declare function startBot(bot: Bot): Promise<void>;
declare function setupGracefulShutdown(bot: Bot): void;
export { initializeBot, startBot, setupGracefulShutdown };
