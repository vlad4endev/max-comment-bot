/**
 * vkPostMappingStore.ts
 *
 * Хранит маппинг: MAX message mid → VK wall post_id (и обратно).
 * Используется vkChainForwarder для синхронизации комментариев.
 *
 * Персистируется в data/vk-post-mapping.json.
 */
interface VkPostMappingEntry {
    /** chainId связки VK */
    chainId: string;
    /** MAX channel chat ID */
    maxChatId: number;
    /** MAX message mid */
    maxMid: string;
    /** VK wall post_id */
    vkPostId: number;
    /** VK group_id (без минуса) */
    vkGroupId: string;
    /** ID последнего обработанного комментария VK для этого поста */
    lastVkCommentId: number;
    createdAt: string;
}
declare class VkPostMappingStore {
    private data;
    private loaded;
    load(): Promise<void>;
    private persist;
    upsert(entry: Omit<VkPostMappingEntry, 'createdAt'>): Promise<void>;
    updateLastCommentId(chainId: string, vkPostId: number, lastVkCommentId: number): Promise<void>;
    findByMaxMid(chainId: string, maxMid: string): VkPostMappingEntry | undefined;
    findByVkPostId(chainId: string, vkPostId: number): VkPostMappingEntry | undefined;
    /** Все активные записи для цепочки (для поллинга комментариев). */
    listByChain(chainId: string): VkPostMappingEntry[];
    /** Удалить записи старше N дней (чтобы файл не рос бесконечно). */
    pruneOlderThan(days: number): Promise<number>;
}
export declare const vkPostMappingStore: VkPostMappingStore;
export {};
