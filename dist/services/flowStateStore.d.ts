declare class FlowStateStore {
    private data;
    private loaded;
    load(): Promise<void>;
    private persist;
    getLastMessageId(flowId: string): number;
    getCursorMeta(flowId: string): {
        lastMessageId: number;
        updatedAt: string | null;
    };
    setLastMessageId(flowId: string, lastMessageId: number): Promise<void>;
    scheduleDelayedPost(flowId: string, postId: string, readyAt: number): Promise<void>;
    popReadyDelayedPosts(flowId: string, now: number): string[];
}
export declare const flowStateStore: FlowStateStore;
export {};
