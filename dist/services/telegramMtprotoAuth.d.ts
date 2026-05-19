import { type MtprotoConfigFile } from './mtprotoConfigStore';
export interface MtprotoStatusView {
    configured: boolean;
    has_credentials: boolean;
    has_session: boolean;
    session_valid: boolean | null;
    source: string;
    api_id: number | null;
    api_hash_set: boolean;
    phone_masked: string | null;
    user_display: string | null;
    updated_at: string | null;
    hint: string | null;
}
export declare function getMtprotoStatus(): Promise<MtprotoStatusView>;
export declare function saveMtprotoCredentials(apiId: number, apiHash: string): MtprotoConfigFile;
export declare function sendMtprotoLoginCode(phoneRaw: string): Promise<{
    login_id: string;
    is_code_via_app: boolean;
    phone_masked: string;
}>;
export declare function confirmMtprotoLoginCode(loginId: string, codeRaw: string): Promise<{
    ok: true;
    user_display: string;
} | {
    ok: false;
    needs_password: true;
    login_id: string;
}>;
export declare function confirmMtprotoPassword(loginId: string, passwordRaw: string): Promise<{
    ok: true;
    user_display: string;
}>;
export declare function testMtprotoConnection(): Promise<{
    user_display: string;
}>;
export declare function logoutMtprotoSession(): void;
