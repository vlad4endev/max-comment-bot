export interface UserState {
    mode: 'idle' | 'commenting' | 'replying';
    /** Если mode === 'commenting' */
    postId?: string;
    /** Если mode === 'replying' */
    replyToUserId?: number;
    createdAt: Date;
}
/**
 * Conversation state keyed by {@link chatId} then {@link userId} so users in different chats never share state.
 */
export declare class StateManager {
    private readonly states;
    private cleanupTimer;
    constructor();
    /**
     * Stores state for a user within a specific chat.
     */
    setState(chatId: number, userId: number, state: UserState): void;
    /**
     * Returns state for a user in a chat, if any.
     */
    getState(chatId: number, userId: number): UserState | undefined;
    /**
     * Deletes state for a user in a chat.
     */
    deleteState(chatId: number, userId: number): void;
    /**
     * Whether the user has an active state entry in the chat.
     */
    hasState(chatId: number, userId: number): boolean;
    /**
     * Counts active state rows for a chat (for diagnostics / commands).
     */
    countStatesInChat(chatId: number): number;
    destroy(): void;
    private runCleanup;
}
export declare const stateManager: StateManager;
