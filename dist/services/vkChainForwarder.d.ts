/**
 * vkChainForwarder.ts
 *
 * Сервис для связки MAX-канала с VK-сообществом:
 * 1. Публикует посты из MAX в VK (вызывается хуком из tgChainForwarder).
 * 2. Опрашивает комментарии VK и синхронизирует их в MAX miniapp.
 * 3. Отправляет новые комментарии из MAX miniapp в VK.
 */
import type { Bot } from '@maxhub/max-bot-api';
export declare function setVkChainForwarderBot(bot: Bot): void;
/**
 * Хук, вызываемый из tgChainForwarder после того, как пост опубликован в MAX-канале.
 * Для всех активных VK-связок этого канала публикует тот же текст в VK.
 */
export declare function onMaxPostPublished(maxChatId: number, maxMid: string, postText: string): Promise<void>;
export declare function startVkChainForwarder(): void;
export declare function stopVkChainForwarder(): void;
