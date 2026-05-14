const crypto = require('crypto');
const express = require('express');

const config = require('./config/config');

const app = express();
const { PORT } = config;

app.use(express.json({ limit: '1mb' }));

/**
 * Документация MAX: при указании secret в подписке на webhook
 * каждый запрос содержит заголовок X-Max-Bot-Api-Secret.
 * Сравнение через timingSafeEqual, чтобы снизить риск timing-атак.
 */
function isValidMaxWebhookSecret(receivedHeader) {
  const expected = process.env.MAX_WEBHOOK_SECRET;
  if (!expected) {
    return { ok: true, skipped: true };
  }

  if (typeof receivedHeader !== 'string' || receivedHeader.length === 0) {
    return { ok: false, skipped: false };
  }

  const a = Buffer.from(receivedHeader, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    return { ok: false, skipped: false };
  }

  try {
    return { ok: crypto.timingSafeEqual(a, b), skipped: false };
  } catch {
    return { ok: false, skipped: false };
  }
}

app.post('/webhook', (req, res) => {
  const secretHeader =
    req.get('X-Max-Bot-Api-Secret') ??
    req.get('x-max-bot-api-secret');

  const secretCheck = isValidMaxWebhookSecret(secretHeader);
  if (!secretCheck.ok) {
    console.warn('[webhook] Отклонено: неверный или пустой X-Max-Bot-Api-Secret');
    return res.status(403).send('Forbidden');
  }

  if (secretCheck.skipped && process.env.NODE_ENV !== 'test') {
    console.warn(
      '[webhook] MAX_WEBHOOK_SECRET не задан — проверка X-Max-Bot-Api-Secret отключена. Для production задайте secret в подписке и в .env.'
    );
  }

  const update = req.body;
  console.log('[webhook] Update:', JSON.stringify(update, null, 2));

  return res.status(200).send('OK');
});

app.listen(PORT, () => {
  console.log(`HTTP-сервер слушает http://0.0.0.0:${PORT} (POST /webhook)`);
  console.log(
    'Напоминание: платформа MAX доставляет webhook по HTTPS:443 на ваш публичный URL; локально обычно используют туннель (ngrok и т.п.).'
  );
});
