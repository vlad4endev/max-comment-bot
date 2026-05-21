/** MAX inline callback: подтвердить связку TG ↔ MAX по коду черновика. */
export function buildConfirmChannelLinkPayload(code: string): string {
  const normalized = String(code).trim().toUpperCase()
  if (!/^[A-Z0-9]{6}$/.test(normalized)) {
    throw new Error('buildConfirmChannelLinkPayload: invalid code')
  }
  return `confirm_link_${normalized}`
}

export function parseConfirmChannelLinkPayload(raw: string): string | null {
  const m = /^confirm_link_([A-Z0-9]{6})$/i.exec(String(raw || '').trim())
  if (!m) {
    return null
  }
  return m[1]!.toUpperCase()
}
