# Чеклист теста синхронизации комментариев

## Предварительные условия

- [ ] Миграция применена: `npx ts-node scripts/apply-comment-sync-migration.ts`
- [ ] В выводе скрипта все пункты с ✅
- [ ] Выбран тестовый chain с `forward_posts: true`
- [ ] У TG-канала привязана Discussion Group (linked chat)
- [ ] Бот добавлен в Discussion Group с правами читать сообщения
- [ ] `forward_comments: true` включён на тестовом chain (см. раздел «Конфиг chain»)

## Конфиг chain

Цепочки TG → MAX хранятся в `data/admin-panel-state.json` (`tg_chains[]`).

Ключевые поля `TgChainRecord`:

| Поле | Тип | Для теста |
|------|-----|-----------|
| `active` | boolean | `true` |
| `forward_posts` | boolean | `true` |
| `forward_comments` | boolean | **`true`** |
| `add_comments_button` | boolean | `true` (чтобы пост попал в miniapp) |
| `max_chat_id` | number | ID канала Max |
| `tg_channel_id` / `tg_username` | string | TG-канал источник |

Включить `forward_comments` через админку:

```http
PATCH /admin/tg-chains/:id
Content-Type: application/json

{ "forward_comments": true }
```

Или вручную в `data/admin-panel-state.json` для нужного chain.

---

## Тест 1: Telegram → Max miniapp

### Шаги

1. Опубликовать пост в TG-канале
2. Дождаться пересылки в Max (обычно < 30 сек)
3. В логах найти:

```
[tgChain] forwarded
```

4. Проверить маппинг в БД (`post_comment_mapping` с `max_mid`)
5. В Discussion Group TG появится авто-репост поста
6. В логах найти:

```
[tgCommentSync] linked discussion post
```

7. Написать комментарий-реплай на авто-репост в Discussion Group
8. В логах найти:

```
[tgCommentSync] synced TG comment to miniapp
```

9. Открыть miniapp под постом в Max
10. **Ожидаемый результат:** комментарий из TG виден в miniapp

### SQL

```sql
SELECT * FROM post_comment_mapping ORDER BY id DESC LIMIT 5;

SELECT comment_id, source, tg_comment_id, synced, text
FROM comments
WHERE source = 'telegram'
ORDER BY created_at DESC LIMIT 5;
```

---

## Тест 2: Max miniapp → Telegram тред

### Шаги

1. Открыть miniapp под тем же постом в Max
2. Администратор отвечает на комментарий из Теста 1
3. В логах найти:

```
[telegramThreadReplySync] delivered admin reply to TG thread
```

4. **Ожидаемый результат:** в Discussion Group ответ вида:

```
👤 Администратор: {текст}
```

как реплай на комментарий пользователя

### SQL

```sql
SELECT comment_id, source, tg_comment_id, tg_thread_reply_id, synced, text
FROM comments
WHERE tg_thread_reply_id IS NOT NULL
ORDER BY created_at DESC LIMIT 5;
```

---

## Тест 3: Защита от петель

### Шаги

1. Написать комментарий в TG-треде
2. Убедиться, что он появился в miniapp (Тест 1)
3. Подождать 30 секунд
4. **Ожидаемый результат:** в TG **нет** второго такого же комментария от бота

### Логи

Не должно быть повторного:

```
[tgCommentSync] synced TG comment to miniapp
```

с тем же `tgCommentId`.

---

## Тест 4: Fallback polling (15 сек)

### Шаги

1. Остановить приложение на 2 минуты
2. Пока остановлено — администратор отвечает в miniapp
3. Запустить приложение снова
4. Подождать до 15 секунд
5. **Ожидаемый результат:** ответ появился в TG-треде (dogоняющий sync через `startMaxCommentSync`)

---

## Возможные проблемы

| Симптом | Причина | Решение |
|---------|---------|---------|
| Комментарий не в miniapp | Бот не в Discussion Group | Добавить бота в группу |
| `post_comment_mapping` пустой | Пост не переслан / нет `max_mid` | Проверить `[tgChain] forwarded` |
| `tg_thread_msg_id` пустой | Авто-репост не пришёл | Проверить linked chat и права бота |
| `forward_comments` выключен | Chain не слушает discussion | `PATCH forward_comments: true` |
| Дубли | Guard не сработал | Проверить `commentSyncGuard` / префикс `👤 Администратор:` |
| Ответ админа не в TG | Нет `tg_thread_msg_id` | Дождаться авто-репоста или новый пост после миграции |
| Пост не в miniapp | Нет кнопки комментариев | `add_comments_button: true` на chain |
