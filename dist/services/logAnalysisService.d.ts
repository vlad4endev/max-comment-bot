import { type AdminLogLevel } from '../utils/adminLogFormat';
import { type LogAiProvider as StoredLogAiProvider } from './logAiSettingsStore';
export type LogAiProvider = StoredLogAiProvider;
export declare const LOG_AI_PROVIDER_PRESETS: Record<LogAiProvider, {
    label: string;
    base_url: string;
    default_model: string;
    models: string[];
    docs_url: string;
}>;
export type LogAnalysisSeverity = 'critical' | 'warning' | 'info';
export type LogAnalysisStatus = 'ok' | 'attention' | 'critical';
export type LogAnalysisFocus = 'general' | 'errors' | 'comment_buttons' | 'database' | 'rate_limit' | 'integrations';
export interface LogAiPublicConfig {
    configured: boolean;
    provider: LogAiProvider;
    provider_label: string;
    model: string;
    base_url: string;
    api_key_preview: string;
    presets: typeof LOG_AI_PROVIDER_PRESETS;
}
export interface LogAnalysisProblem {
    severity: LogAnalysisSeverity;
    title: string;
    description: string;
    what_to_do: string;
    count?: number;
}
export interface LogAnalysisReport {
    summary: string;
    health_score: number;
    status: LogAnalysisStatus;
    problems: LogAnalysisProblem[];
    working_well: string[];
    recommendations: string[];
    analyzed_at: string;
    logs_analyzed: number;
    model: string;
}
export interface AnalyzeLogsOptions {
    limit?: number;
    level?: AdminLogLevel | null;
    filter?: string;
    focus?: LogAnalysisFocus;
}
export declare function getLogAiPublicConfig(): LogAiPublicConfig;
export declare function saveLogAiConfig(input: {
    provider?: string;
    api_key?: string;
    base_url?: string;
    model?: string;
}): Promise<LogAiPublicConfig>;
export declare function testLogAiConnection(): Promise<{
    ok: true;
    reply: string;
    model: string;
    provider: LogAiProvider;
}>;
export declare function analyzeLogs(options?: AnalyzeLogsOptions): Promise<LogAnalysisReport>;
