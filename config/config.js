const path = require('path');
const dotenv = require('dotenv');

const rootEnv = path.join(__dirname, '..', '.env');
const localEnv = path.join(__dirname, '.env');

dotenv.config({ path: rootEnv });
dotenv.config({ path: localEnv, override: true });

const apiToken = process.env.MAX_API_TOKEN?.trim() ?? '';
if (!apiToken) {
  throw new Error(
    'MAX_API_TOKEN не задан. Скопируйте config/.env.example в .env в корне проекта (или в config/.env), укажите токен бота и перезапустите приложение.'
  );
}

const portRaw = process.env.PORT ?? '3000';
const portParsed = Number.parseInt(portRaw, 10);

const config = {
  API_TOKEN: apiToken,
  ADMIN_CHAT_ID: process.env.ADMIN_CHAT_ID ?? '',
  BOT_NICKNAME: process.env.BOT_NICKNAME ?? '',
  API_BASE: 'https://platform-api.max.ru',
  PORT: Number.isFinite(portParsed) && portParsed > 0 ? portParsed : 3000,
};

module.exports = config;
