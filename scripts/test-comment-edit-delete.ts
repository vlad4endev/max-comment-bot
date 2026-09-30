/**
 * Правки и удаления комментариев Telegram → MAX (без сети).
 * Пишет в data/ рядом со скриптом — запускайте на копии проекта.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const dataDir = path.resolve(__dirname, '../data')
fs.rmSync(dataDir, { recursive: true, force: true })
fs.mkdirSync(dataDir, { recursive: true })

async function main(): Promise<void> {
  const { getDb } = await import('../src/db/database')
  const { commentStore } = await import('../src/services/commentStore')
  const { postStore } = await import('../src/services/postStore')
  const queue = await import('../src/services/tgChainForwardQueue')
  const sync = await import('../src/services/commentEditDeleteSync')
  const { buildEditedMaxCommentTelegramText } = await import(
    '../src/services/telegramThreadReplySync'
  )
  const db = getDb()
  db.pragma('foreign_keys = OFF')
  postStore.savePost({
    post_id: 'p1',
    chat_id: 1,
    message_mid: 'mid1',
    text: 't',
    comment_count: 0,
    timestamp: new Date().toISOString(),
  })

  const chain = { id: 'chainA', active: true, forward_comments: true, max_chat_id: 1 } as never
  const base = { post_id: 'p1', user_id: 5, username: 'u' }
  const tgComment = commentStore.saveTelegramThreadComment({ ...base, text: 'old' }, 10, -1001)
  const maxComment = commentStore.saveComment({ ...base, text: 'from max' })
  commentStore.setTgCommentId(maxComment.comment_id, -1001, 11, 'MAX · u: from max')
  postStore.incrementCommentCount('p1')

  const edited = (id: number, text: string) =>
    ({ message_id: id, chat: { id: -1001 }, text, reply_to_message: { message_id: 1 } }) as never

  // TG → MAX: правка меняет текст комментария Telegram-происхождения.
  assert.equal(await sync.handleTgCommentEdited(edited(10, 'new'), chain, -1001), 'updated')
  assert.equal(commentStore.getComment(tgComment.comment_id)!.text, 'new')
  assert.equal(await sync.handleTgCommentEdited(edited(10, 'new'), chain, -1001), 'ignored', 'same text')
  assert.equal(await sync.handleTgCommentEdited(edited(10, 'MAX · x: y'), chain, -1001), 'ignored', 'service text')
  assert.equal(await sync.handleTgCommentEdited(edited(10, ''), chain, -1001), 'ignored', 'empty text')
  // Копию MAX-комментария в Telegram правит только MAX.
  assert.equal(await sync.handleTgCommentEdited(edited(11, 'hack'), chain, -1001), 'ignored')
  assert.equal(commentStore.getComment(maxComment.comment_id)!.text, 'from max')
  // Чужой чат с тем же message_id не трогаем.
  assert.equal(await sync.handleTgCommentEdited({ ...(edited(10, 'other') as object), chat: { id: -2002 } } as never, chain, -2002), 'ignored')

  // Правка до переноса: обновляется сообщение в очереди входящих.
  const pending = { message_id: 50, chat: { id: -1001 }, text: 'v1', message_thread_id: 1 } as never
  queue.upsertCommentInboundJob({ chainId: 'chainA', discussionChatId: -1001, message: pending })
  assert.equal(await sync.handleTgCommentEdited(edited(50, 'v2'), chain, -1001), 'queued')
  const job = queue.listDueCommentInboundJobs().find((j) => j.job_key === 'chainA:50')!
  assert.equal(queue.parseInboundCommentMessage(job.payload)!.text, 'v2')
  assert.equal(await sync.handleTgCommentEdited(edited(51, 'nothing'), chain, -1001), 'ignored')

  // TG → MAX: удаление убирает только комментарии Telegram-происхождения.
  const removed = await sync.handleTgCommentsDeleted(-1001, [10, 11, 999], null)
  assert.deepEqual(removed, [tgComment.comment_id])
  assert.equal(commentStore.getComment(tgComment.comment_id), null)
  assert.ok(commentStore.getComment(maxComment.comment_id), 'MAX comment kept')
  assert.equal(postStore.getPost('p1')!.comment_count, 1, 'count follows DB')
  assert.deepEqual(await sync.handleTgCommentsDeleted(-2002, [10], null), [], 'other chat untouched')

  // MAX → TG: текст копии после правки, с сохранением маркера брони.
  const fresh = commentStore.getComment(maxComment.comment_id)!
  assert.equal(buildEditedMaxCommentTelegramText(fresh, 'edited'), 'MAX · u: edited')
  commentStore.markBookedInMaxTelegram(fresh.comment_id)
  const booked = buildEditedMaxCommentTelegramText(commentStore.getComment(fresh.comment_id)!, 'edited')
  assert.ok(booked.startsWith('MAX · u: edited') && booked.includes('🔒'))

  console.log('OK: comment edit/delete')
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
