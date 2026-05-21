/** MAX inline callback: подтвердить связку TG ↔ MAX по коду черновика. */
export declare function buildConfirmChannelLinkPayload(code: string): string;
export declare function parseConfirmChannelLinkPayload(raw: string): string | null;
