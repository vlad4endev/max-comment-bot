export interface UserState {
    mode: 'idle' | 'commenting' | 'replying';
    /** Если mode === 'commenting' */
    postId?: string;
    /** Если mode === 'replying' */
    replyToUserId?: number;
    createdAt: Date;
}
export declare class StateManager {
    private readonly states;
    private cleanupTimer;
    constructor();
    setState(userId: number, state: UserState): void;
    getState(userId: number): UserState | undefined;
    deleteState(userId: number): void;
    hasState(userId: number): boolean;
    destroy(): void;
    private runCleanup;
}
export declare const stateManager: StateManager;
