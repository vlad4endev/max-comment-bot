/** Имя cookie с подписанной сессией панели управления. */
export declare const ADMIN_PANEL_COOKIE_NAME = "admin_panel";
export declare function adminPanelCredentialsMatch(username: string, password: string, expectedUser: string, expectedPass: string): boolean;
export declare function signAdminPanelSessionValue(secret: string): string;
export declare function verifyAdminPanelSessionValue(secret: string, raw: string | null | undefined): boolean;
export declare function adminPanelSessionCookieHeader(secret: string, maxAgeSec: number, secure: boolean): string;
export declare function adminPanelLogoutCookieHeader(secure: boolean): string;
