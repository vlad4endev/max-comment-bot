/** MAX startapp allows A–Z, a–z, 0–9, _, - */
export function encodeMessageMidForStartapp(messageMid: string): string {
  return Buffer.from(messageMid, 'utf8')
    .toString('base64url')
    .replace(/=/g, '')
}

export function decodeMessageMidFromStartapp(encoded: string): string | null {
  const trimmed = encoded.trim()
  if (!trimmed) {
    return null
  }
  try {
    const padded = trimmed + '='.repeat((4 - (trimmed.length % 4)) % 4)
    return Buffer.from(padded, 'base64url').toString('utf8')
  } catch {
    return null
  }
}
