import type { Bot } from '@maxhub/max-bot-api';
import type { Update } from '@maxhub/max-bot-api/types';
export declare function dispatchBotUpdate(bot: Bot, update: Update): Promise<void>;
