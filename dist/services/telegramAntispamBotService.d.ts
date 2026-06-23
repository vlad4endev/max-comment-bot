import { type TgChainRecord } from '../api/adminPanelState';
import { type TgMessage } from '../forwarder/telegramReader';
import { isTelegramAntispamBotConfigured, resolveTelegramAntispamBotToken } from './resolveTelegramAntispamBotToken';
export { isTelegramAntispamBotConfigured, resolveTelegramAntispamBotToken };
/**
 * Проверка и блокировка спам-комментария в TG-обсуждении.
 * @returns true если комментарий заблокирован.
 */
export declare function tryBlockTelegramCommentByAntispam(message: TgMessage, chain: TgChainRecord, discussionChatId: number, tgCommentId: number, enforcementToken?: string): Promise<boolean>;
export declare function runTelegramAntispamBotOnce(): Promise<boolean>;
export declare function startTelegramAntispamBotPoller(): () => void;
