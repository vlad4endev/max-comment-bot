/**
 * Album frames must stay in the channel order, not jump behind every single post.
 *   npx ts-node scripts/test-tg-forward-groups.ts
 */
import assert from 'node:assert/strict'

import { groupChannelPostsForForward } from '../src/services/tgForwardGroups'

const chat = { id: -1001 }
const msg = (message_id: number, media_group_id?: string) => ({
  message_id,
  media_group_id,
  chat,
})

const groups = groupChannelPostsForForward([
  msg(1),
  msg(2, 'album-a'),
  msg(4, 'album-a'),
  msg(3, 'album-a'),
  msg(5),
  msg(6, 'album-b'),
  msg(7, 'album-b'),
])

assert.deepEqual(
  groups.map((group) => group.map((item) => item.message_id)),
  [[1], [2, 3, 4], [5], [6, 7]],
  'mixed batch must keep album position and sort frames by message_id',
)

assert.deepEqual(
  groupChannelPostsForForward([msg(9, 'only'), msg(8, 'only')]).map((group) =>
    group.map((item) => item.message_id),
  ),
  [[8, 9]],
)

console.log('OK: telegram forward groups keep channel order')
