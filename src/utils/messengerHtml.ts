/** HTML subset shared by Telegram Bot API and MAX messenger. */

const FORMAT_TAG =
  /<\/?(?:b|strong|i|em|u|ins|s|strike|del|code|pre|a|blockquote|br|span|spoiler)\b[^>]*>/i

export function hasMessengerHtmlFormatting(text: string): boolean {
  return FORMAT_TAG.test(text)
}

/** Escape plain text for HTML parse_mode when no tags present. */
export function escapePlainForHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** Prepare text + optional parse_mode for Telegram / MAX HTML APIs. */
export function prepareMessengerHtmlText(text: string): {
  text: string
  parseMode?: 'HTML'
} {
  const trimmed = text.trim()
  if (!trimmed) {
    return { text: '\u00a0' }
  }
  if (!hasMessengerHtmlFormatting(trimmed)) {
    return { text: trimmed }
  }
  return { text: trimmed.slice(0, 4096), parseMode: 'HTML' }
}
