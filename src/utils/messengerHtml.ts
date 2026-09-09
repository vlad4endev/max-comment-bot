/** HTML subset shared by Telegram Bot API and MAX messenger. */

const FORMAT_TAG =
  /<\/?(?:b|strong|i|em|u|ins|s|strike|del|code|pre|a|blockquote|span|spoiler|mark|h[1-6])\b[^>]*>/i

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

/** Telegram/MAX HTML do not accept `<br>` — line breaks must be real newlines. */
export function brTagsToNewlines(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
}

/** MAX HTML has no spoiler tags; unwrap so format=html is not rejected. */
function unwrapMaxUnsupportedTags(text: string): string {
  return text
    .replace(/<span\s+class="tg-spoiler">(.*?)<\/span>/gis, '$1')
    .replace(/<\/?spoiler>/gi, '')
}

export type MessengerHtmlPlatform = 'telegram' | 'max'

/** Prepare text + optional parse_mode for Telegram / MAX HTML APIs. */
export function prepareMessengerHtmlText(
  text: string,
  options?: { platform?: MessengerHtmlPlatform },
): {
  text: string
  parseMode?: 'HTML'
} {
  let next = brTagsToNewlines(text)
  if (options?.platform === 'max') {
    next = unwrapMaxUnsupportedTags(next)
  }
  const trimmed = next.trim()
  if (!trimmed) {
    return { text: '\u00a0' }
  }
  if (!hasMessengerHtmlFormatting(trimmed)) {
    return { text: trimmed }
  }
  const maxLen = options?.platform === 'max' ? 4000 : 4096
  return { text: trimmed.slice(0, maxLen), parseMode: 'HTML' }
}
