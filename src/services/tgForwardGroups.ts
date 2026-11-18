/** Minimal shape needed to keep Telegram channel batches in publish order. */
export type ForwardGroupItem = {
  message_id: number
  media_group_id?: string
  chat: { id: number }
}

/**
 * Groups a channel batch into singles and albums without pulling albums to the end.
 * Album frames stay together (sorted by message_id) at the position of the first frame.
 */
export function groupChannelPostsForForward<T extends ForwardGroupItem>(posts: T[]): T[][] {
  const albums = new Map<string, T[]>()
  for (const msg of posts) {
    const gid = msg.media_group_id?.trim()
    if (!gid) {
      continue
    }
    const key = `${msg.chat.id}:${gid}`
    const list = albums.get(key) ?? []
    list.push(msg)
    albums.set(key, list)
  }
  for (const list of albums.values()) {
    list.sort((a, b) => a.message_id - b.message_id)
  }

  const emitted = new Set<string>()
  const out: T[][] = []
  for (const msg of posts) {
    const gid = msg.media_group_id?.trim()
    if (!gid) {
      out.push([msg])
      continue
    }
    const key = `${msg.chat.id}:${gid}`
    if (emitted.has(key)) {
      continue
    }
    emitted.add(key)
    out.push(albums.get(key) ?? [msg])
  }
  return out
}
