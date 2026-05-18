export type IntegrationPlatform = 'telegram' | 'vk';
export type FlowPlatform = 'telegram' | 'vk' | 'max';
export interface IntegrationStats {
    totalPosts: number;
    lastActivity: string | null;
}
export interface IntegrationRecord {
    id: string;
    platform: IntegrationPlatform;
    name: string;
    token: string;
    groupId?: string;
    status: 'connected' | 'disconnected' | 'error';
    connectedAt: string;
    stats: IntegrationStats;
}
export interface FlowFilters {
    keywords: string[];
    excludeKeywords: string[];
    mediaOnly: boolean;
    delaySeconds: number;
}
export interface FlowSource {
    integrationId: string;
    platform: FlowPlatform;
    channelUsername?: string;
    channelId?: string;
    contentTypes?: string[];
}
export interface FlowDestination {
    platform: FlowPlatform;
    channelId: string;
    integrationId?: string;
    addCommentsButton?: boolean;
    signature?: string;
}
export interface FlowStats {
    totalForwarded: number;
    lastForwardedAt: string | null;
    errors: number;
}
export interface FlowRecord {
    id: string;
    name: string;
    enabled: boolean;
    source: FlowSource;
    filters: FlowFilters;
    destination: FlowDestination;
    stats: FlowStats;
    createdAt: string;
}
export interface ForwardedLogEntry {
    id: string;
    flowId: string;
    fromPlatform: string;
    fromChannel: string;
    toPlatform: string;
    toChannel: string;
    preview: string;
    forwardedAt: string;
}
declare class IntegrationsStore {
    private data;
    private loaded;
    load(): Promise<void>;
    private persist;
    getIntegrations(): IntegrationRecord[];
    getIntegration(id: string): IntegrationRecord | undefined;
    upsertIntegration(input: Omit<IntegrationRecord, 'id' | 'connectedAt' | 'stats'> & {
        id?: string;
        connectedAt?: string;
        stats?: IntegrationStats;
    }): Promise<IntegrationRecord>;
    deleteIntegration(id: string): Promise<boolean>;
    getFlows(): FlowRecord[];
    getFlow(id: string): FlowRecord | undefined;
    saveFlow(flow: FlowRecord): Promise<void>;
    deleteFlow(id: string): Promise<boolean>;
    updateFlowStats(id: string, patch: Partial<FlowStats> & {
        incrementForwarded?: number;
        incrementErrors?: number;
    }): Promise<void>;
    appendForwardedLog(entry: Omit<ForwardedLogEntry, 'id' | 'forwardedAt'>): Promise<void>;
    getForwardedLog(limit: number, flowId?: string): ForwardedLogEntry[];
    bumpIntegrationActivity(integrationId: string, posts?: number): Promise<void>;
}
export declare const integrationsStore: IntegrationsStore;
export declare function maskToken(token: string): string;
export declare function integrationPublicView(i: IntegrationRecord): Record<string, unknown>;
export {};
