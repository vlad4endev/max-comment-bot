import { randomUUID } from 'node:crypto'

import { getPostsDb } from '../db/postsDatabase'

export interface PostTemplateRecord {
  id: string
  name: string
  text: string
  media: { type: 'photo' | 'video'; path: string }[]
  created_at: string
  updated_at: string
}

interface TemplateDbRow {
  id: string
  name: string
  text: string
  media_json: string
  created_at: string
  updated_at: string
}

function rowToTemplate(row: TemplateDbRow): PostTemplateRecord {
  let media: PostTemplateRecord['media'] = []
  try {
    const parsed = JSON.parse(row.media_json) as unknown
    if (Array.isArray(parsed)) media = parsed as PostTemplateRecord['media']
  } catch {
    /* ignore */
  }
  return {
    id: row.id,
    name: row.name,
    text: row.text,
    media,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export function listPostTemplates(): PostTemplateRecord[] {
  const rows = getPostsDb()
    .prepare('SELECT * FROM post_templates ORDER BY name ASC')
    .all() as TemplateDbRow[]
  return rows.map(rowToTemplate)
}

export function getPostTemplateById(id: string): PostTemplateRecord | null {
  const row = getPostsDb().prepare('SELECT * FROM post_templates WHERE id = ?').get(id) as
    | TemplateDbRow
    | undefined
  return row ? rowToTemplate(row) : null
}

export function createPostTemplate(input: { name: string; text: string; media?: PostTemplateRecord['media'] }): PostTemplateRecord {
  const id = randomUUID()
  const now = new Date().toISOString()
  getPostsDb()
    .prepare(
      `INSERT INTO post_templates (id, name, text, media_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, input.name, input.text, JSON.stringify(input.media ?? []), now, now)
  return getPostTemplateById(id)!
}

export function updatePostTemplate(
  id: string,
  patch: { name?: string; text?: string; media?: PostTemplateRecord['media'] },
): PostTemplateRecord | null {
  const current = getPostTemplateById(id)
  if (!current) return null
  const now = new Date().toISOString()
  getPostsDb()
    .prepare(
      `UPDATE post_templates SET name = ?, text = ?, media_json = ?, updated_at = ? WHERE id = ?`,
    )
    .run(
      patch.name ?? current.name,
      patch.text ?? current.text,
      JSON.stringify(patch.media ?? current.media),
      now,
      id,
    )
  return getPostTemplateById(id)
}

export function deletePostTemplate(id: string): boolean {
  const result = getPostsDb().prepare('DELETE FROM post_templates WHERE id = ?').run(id)
  return result.changes > 0
}
