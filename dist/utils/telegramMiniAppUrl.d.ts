/** URL, который Telegram принимает для Web App (HTTPS, не t.me, не localhost/LAN). */
export declare function isTelegramWebAppUrl(url: string): boolean;
export declare function isPrivateOrLocalMiniAppHost(url: string): boolean;
/** Собрать `https://домен/miniapp` из `WEBHOOK_URL`, если `MINI_APP_URL` не задан. */
export declare function deriveMiniAppUrlFromWebhook(webhookUrl: string): string | undefined;
export declare function normalizeMiniAppUrl(raw: string): string | undefined;
export type TelegramOpenPanelButton = {
    text: string;
    web_app: {
        url: string;
    };
} | {
    text: string;
    url: string;
};
/** Кнопка «Открыть панель»: Web App только для валидного HTTPS URL, иначе ссылка на бота. */
export declare function buildTelegramOpenPanelButton(homeUrl: string | null | undefined, botUsername?: string): TelegramOpenPanelButton;
/** Публичный HTTPS URL мини-приложения (MAX и Telegram Web App). */
export declare function isPublicHttpsMiniAppUrl(url: string): boolean;
/** Предупреждения при старте: LAN/HTTP URL не откроются с мобильного интернета. */
export declare function logMiniAppUrlDiagnostics(miniAppUrl: string | undefined, botNickname: string): void;
/** @deprecated Используйте {@link logMiniAppUrlDiagnostics}. */
export declare function logTelegramMiniAppUrlDiagnostics(miniAppUrl: string | undefined): void;
