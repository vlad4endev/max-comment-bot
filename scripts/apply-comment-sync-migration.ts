/**
 * apply-comment-sync-migration.ts
 *
 * Одноразовый скрипт для применения миграции comment sync.
 * Запускать вручную: npx ts-node scripts/apply-comment-sync-migration.ts
 *
 * Что делает:
 * 1. Открывает существующий data/bot.db
 * 2. Вызывает getDb() → initSchema() → migrateCommentSyncSchema() выполнится автоматически
 * 3. Проверяет что таблицы и колонки созданы
 * 4. Выводит результат
 */

import { getDb } from '../src/db/database'

function main(): void {
  console.log('Applying comment sync migration...')

  const db = getDb()

  const tableExists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='post_comment_mapping'`)
    .get()
  console.log('post_comment_mapping:', tableExists ? '✅ создана' : '❌ не найдена')

  const commentCols = db.prepare(`PRAGMA table_info(comments)`).all() as Array<{ name: string }>
  const commentColNames = commentCols.map((c) => c.name)

  const commentRequired = [
    'tg_comment_id',
    'max_comment_id',
    'source',
    'synced',
    'tg_thread_reply_id',
  ]
  for (const col of commentRequired) {
    console.log(
      `comments.${col}:`,
      commentColNames.includes(col) ? '✅ есть' : '❌ отсутствует',
    )
  }

  const mappingCols = db
    .prepare(`PRAGMA table_info(post_comment_mapping)`)
    .all() as Array<{ name: string }>
  const mappingColNames = mappingCols.map((c) => c.name)

  const mappingRequired = ['chain_id', 'tg_msg_id', 'max_mid', 'tg_thread_chat_id', 'tg_thread_msg_id']
  for (const col of mappingRequired) {
    console.log(
      `post_comment_mapping.${col}:`,
      mappingColNames.includes(col) ? '✅ есть' : '❌ отсутствует',
    )
  }

  const indexes = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type='index'
         AND (name LIKE 'idx_%comment%' OR name LIKE 'idx_post_comment%')`,
    )
    .all() as Array<{ name: string }>
  console.log(
    'Индексы comment sync:',
    indexes.map((i) => i.name).join(', ') || 'нет',
  )

  console.log('\nМиграция завершена.')
}

main()
