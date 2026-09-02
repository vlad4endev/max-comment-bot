# WireGuard только для Telegram (этот проект)

Клиент в Docker (`wgtg`) подключается к уже существующему VPS Veresk. Хостовый `wg0` другого проекта не трогаем.

| | На хосте skypath | Этот бот |
|---|---|---|
| Интерфейс | чужой `wg0` | контейнер `wgtg` |
| Endpoint | как у них | `130.49.161.246:32510` |
| Адрес в туннеле | их | `10.0.0.2/32` |
| Куда гоняем трафик | их логика | только диапазоны Telegram |

```
контейнер bot
  → socks5://wg-telegram:1080
  → wgtg → 130.49.161.246:32510
  → api.telegram.org
```

Сервер на VPS уже есть — новый `wg-quick` там поднимать не нужно. Файл `wgtg.conf` с ключами на диске, в git не попадает.

Если Veresk на этом же skypath уже сидит с **тем же** ключом и `10.0.0.2`, два клиента будут выбивать handshake друг друга. Тогда на VPS нужен второй peer (`10.0.0.3`) — напишите, сделаем отдельный ключ.

## skypath

В `.env`:

```bash
COMPOSE_PROFILES=telegram-vpn
TELEGRAM_PROXY_URL=socks5://wg-telegram:1080
```

Скопируйте `deploy/wireguard/wgtg.conf` на сервер (его нет в git), затем:

```bash
cd ~/max-comment-bot
docker compose --profile telegram-vpn up -d --build wg-telegram
docker compose up -d --force-recreate --no-deps bot
bash scripts/wg-telegram-check.sh
```

В админке: **Настройки → Прокси Telegram** → `socks5://wg-telegram:1080`. Если в `data/telegram-proxies.json` уже есть список, `TELEGRAM_PROXY_URL` его не перезапишет.

## Чего не делать

- Не `wg-quick down wg0` и не править `/etc/wireguard/wg0.conf`
- Не `AllowedIPs = 0.0.0.0/0` в `wgtg.conf`

## Handshake не идёт

- UDP **32510** на `130.49.161.246` открыт
- `PersistentKeepalive = 25` уже в конфиге
- NAT и `ip_forward` на VPS (раз Veresk ходит — обычно уже включено)
