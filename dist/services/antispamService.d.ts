import { type AntispamDetectAction } from '../antispam/detectSpam';
export type AntispamSource = 'max' | 'telegram' | 'vk';
export interface AntispamInput {
    text: string;
    userId: number;
    username: string | null;
    channelChatId: number;
    source: AntispamSource;
    /** Админ канала / модератор — пропускает проверку. */
    isChannelAdmin?: boolean;
}
export type AntispamOutcome = 'allow' | 'block' | 'ban' | 'soft_log';
export interface AntispamEvaluation {
    allowed: boolean;
    outcome: AntispamOutcome;
    action: AntispamDetectAction | 'whitelist' | 'blacklist' | 'restricted';
    spamScore: number;
    categories: string[];
    reason: string;
    userMessage?: string;
}
/**
 * Единая точка антиспама для MAX, Telegram и VK.
 * Порт логики antispam_v16 из n8n.
 */
export declare function evaluateComment(input: AntispamInput): AntispamEvaluation;
