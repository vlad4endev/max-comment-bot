"use strict";
/** HTML subset shared by Telegram Bot API and MAX messenger. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.hasMessengerHtmlFormatting = hasMessengerHtmlFormatting;
exports.escapePlainForHtml = escapePlainForHtml;
exports.prepareMessengerHtmlText = prepareMessengerHtmlText;
const FORMAT_TAG = /<\/?(?:b|strong|i|em|u|ins|s|strike|del|code|pre|a|blockquote|br|span|spoiler)\b[^>]*>/i;
function hasMessengerHtmlFormatting(text) {
    return FORMAT_TAG.test(text);
}
/** Escape plain text for HTML parse_mode when no tags present. */
function escapePlainForHtml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
/** Prepare text + optional parse_mode for Telegram / MAX HTML APIs. */
function prepareMessengerHtmlText(text) {
    const trimmed = text.trim();
    if (!trimmed) {
        return { text: '\u00a0' };
    }
    if (!hasMessengerHtmlFormatting(trimmed)) {
        return { text: trimmed };
    }
    return { text: trimmed.slice(0, 4096), parseMode: 'HTML' };
}
//# sourceMappingURL=messengerHtml.js.map