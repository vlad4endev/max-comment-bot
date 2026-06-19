/** HTML subset shared by Telegram Bot API and MAX messenger. */
export declare function hasMessengerHtmlFormatting(text: string): boolean;
/** Escape plain text for HTML parse_mode when no tags present. */
export declare function escapePlainForHtml(text: string): string;
/** Prepare text + optional parse_mode for Telegram / MAX HTML APIs. */
export declare function prepareMessengerHtmlText(text: string): {
    text: string;
    parseMode?: 'HTML';
};
