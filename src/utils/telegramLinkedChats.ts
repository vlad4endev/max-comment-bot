export interface TelegramLinkedChatApiView {
  id: string
  title: string
  username: string | null
  type: string
  botIsAdmin: boolean
}

/** Безопасное приведение linkedChats к ответу API (защита от битых данных в integrations.json). */
export function normalizeTelegramLinkedChatsForApi(linkedChats: unknown): TelegramLinkedChatApiView[] {
  const list = Array.isArray(linkedChats) ? linkedChats : []
  const out: TelegramLinkedChatApiView[] = []
  for (const chat of list) {
    const record =
      typeof chat === 'object' && chat !== null ? (chat as Record<string, unknown>) : null
    const id = String(record?.id ?? '').trim()
    if (!id) {
      continue
    }
    out.push({
      id,
      title: String(record?.title ?? 'Без названия'),
      username: typeof record?.username === 'string' ? record.username : null,
      type: typeof record?.type === 'string' ? record.type : 'channel',
      botIsAdmin: record?.botIsAdmin === true,
    })
  }
  return out
}
