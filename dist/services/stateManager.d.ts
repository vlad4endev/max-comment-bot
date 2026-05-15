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
    /**
     * Maps MAX user id → private dialog `chat_id` where the user opened the bot (`bot_started`).
     * Used to DM the user during onboarding when `bot_added` does not include a reliable inviter.
     */
    private readonly userPrivateChatIdByUserId;
    /**
     * Channel `chat_id` values where the bot was added but is not yet admin/owner — awaiting rights or `/connect`.
     */
    private readonly pendingAdminChannelIds;
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
    /**
     * Remembers the user's private chat id after `bot_started` so the bot can DM them later.
     */
    setUserPrivateChatId(userId: number, privateChatId: number): void;
    /**
     * Returns the private dialog chat id previously stored for this user, if any.
     */
    getUserPrivateChatId(userId: number): number | undefined;
    /**
     * Removes remembered private dialog chat id for this user.
     */
    clearUserPrivateChatId(userId: number): void;
    /**
     * Deletes all transient conversation states for this user across every chat.
     */
    clearAllStatesForUser(userId: number): void;
    /**
     * Marks a channel as waiting for admin rights (or manual `/connect` after rights are granted).
     */
    markChannelPendingAdminRights(channelChatId: number): void;
    /**
     * Clears the pending-admin marker when the channel is registered or no longer relevant.
     */
    clearChannelPendingAdminRights(channelChatId: number): void;
    /**
     * Whether the channel is still waiting for admin rights / activation.
     */
    isChannelPendingAdminRights(channelChatId: number): boolean;
    /**
     * Snapshot of all channel ids pending admin-based registration (for `/connect` sweep).
     */
    getPendingAdminChannelIds(): number[];
    destroy(): void;
    private runCleanup;
}
export declare const stateManager: StateManager;
