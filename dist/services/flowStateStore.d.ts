declare class FlowStateStore {
    private data;
    private loaded;
    load(): Promise<void>;
    private persist;
    getLastMessageId(flowId: string): number;
    setLastMessageId(flowId: string, lastMessageId: number): Promise<void>;
    scheduleDelayedPost(flowId: string, postId: string, readyAt: number): Promise<void>;
    popReadyDelayedPosts(flowId: string, now: number): string[];
}
export declare const flowStateStore: FlowStateStore;
export {};
