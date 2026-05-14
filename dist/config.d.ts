export interface Config {
    BOT_TOKEN: string;
    ADMIN_CHAT_ID: number;
    BOT_NICKNAME: string;
    NODE_ENV: 'development' | 'production';
    PORT: number;
}
export declare const config: Config;
