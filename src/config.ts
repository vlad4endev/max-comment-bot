import dotenv from 'dotenv';

dotenv.config();

export interface Config {
  BOT_TOKEN: string;
  ADMIN_CHAT_ID: number;
  BOT_NICKNAME: string;
  NODE_ENV: 'development' | 'production';
  PORT: number;
}

function getConfig(): Config {
  const BOT_TOKEN = (process.env.BOT_TOKEN ?? '').trim();
  if (!BOT_TOKEN) {
    throw new Error('BOT_TOKEN не установлен');
  }

  const adminChatIdRaw = (process.env.ADMIN_CHAT_ID ?? '').trim();
  if (adminChatIdRaw === '') {
    throw new Error('ADMIN_CHAT_ID должен быть числом');
  }
  const adminParsed = Number(adminChatIdRaw);
  if (!Number.isFinite(adminParsed) || !Number.isInteger(adminParsed)) {
    throw new Error('ADMIN_CHAT_ID должен быть числом');
  }

  const BOT_NICKNAME = (process.env.BOT_NICKNAME ?? '').trim();
  if (!BOT_NICKNAME) {
    throw new Error('BOT_NICKNAME не установлен');
  }

  const NODE_ENV: Config['NODE_ENV'] =
    process.env.NODE_ENV === 'production' ? 'production' : 'development';

  const portRaw = process.env.PORT;
  let PORT = 3000;
  if (portRaw !== undefined && portRaw !== '') {
    const parsed = Number.parseInt(portRaw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      PORT = parsed;
    }
  }

  return {
    BOT_TOKEN,
    ADMIN_CHAT_ID: adminParsed,
    BOT_NICKNAME,
    NODE_ENV,
    PORT,
  };
}

export const config = getConfig();
