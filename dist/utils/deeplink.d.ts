export interface ParsedPayload {
    type: string;
    id: string;
}
export declare function generateDeeplink(payload: string, botNickname?: string): string;
export declare function parsePayload(payload: string | null): ParsedPayload | null;
