"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendTextToMax = sendTextToMax;
exports.sendPhotoFileToMax = sendPhotoFileToMax;
exports.sendVideoFileToMax = sendVideoFileToMax;
exports.sendDocumentFileToMax = sendDocumentFileToMax;
exports.sendPhotoToMax = sendPhotoToMax;
exports.sendVideoToMax = sendVideoToMax;
exports.sendDocumentToMax = sendDocumentToMax;
const promises_1 = __importDefault(require("node:fs/promises"));
const node_path_1 = __importDefault(require("node:path"));
const axios_1 = __importDefault(require("axios"));
const form_data_1 = __importDefault(require("form-data"));
/** Официальный API MAX (как в @maxhub/max-bot-api). Старый botapi.max.ru/messages/sendMessage даёт 404. */
const MAX_API = 'https://platform-api.max.ru';
function maxAuthHeaders(token) {
    return { Authorization: token.trim() };
}
async function postMessage(token, chatId, body) {
    await axios_1.default.post(`${MAX_API}/messages`, body, {
        params: { chat_id: chatId },
        headers: {
            ...maxAuthHeaders(token),
            'Content-Type': 'application/json',
        },
    });
}
async function uploadBufferToMax(token, type, buffer, filename, contentType) {
    const slot = await axios_1.default.post(`${MAX_API}/uploads`, null, {
        params: { type },
        headers: maxAuthHeaders(token),
    });
    const uploadUrl = slot.data.url;
    const uploadToken = slot.data.token;
    const form = new form_data_1.default();
    form.append('data', buffer, { filename, contentType });
    await axios_1.default.post(uploadUrl, form, { headers: form.getHeaders() });
    if (!uploadToken) {
        throw new Error('MAX upload: missing token in uploads response');
    }
    return uploadToken;
}
async function sendTextToMax(token, chatId, text) {
    await postMessage(token, chatId, { text: text.substring(0, 4096) });
}
async function sendPhotoFileToMax(token, chatId, filePath, caption) {
    const buffer = await promises_1.default.readFile(filePath);
    const name = node_path_1.default.basename(filePath);
    const uploadToken = await uploadBufferToMax(token, 'image', buffer, name, 'image/jpeg');
    await postMessage(token, chatId, {
        text: caption.substring(0, 1024) || '\u00a0',
        attachments: [{ type: 'image', payload: { token: uploadToken } }],
    });
}
async function sendVideoFileToMax(token, chatId, filePath, caption) {
    const buffer = await promises_1.default.readFile(filePath);
    const name = node_path_1.default.basename(filePath);
    const ext = node_path_1.default.extname(name).toLowerCase();
    const contentType = ext === '.webm' ? 'video/webm' : ext === '.mov' ? 'video/quicktime' : 'video/mp4';
    const uploadToken = await uploadBufferToMax(token, 'video', buffer, name, contentType);
    await postMessage(token, chatId, {
        text: caption.substring(0, 1024) || '\u00a0',
        attachments: [{ type: 'video', payload: { token: uploadToken } }],
    });
}
async function sendDocumentFileToMax(token, chatId, filePath, caption, options) {
    const buffer = await promises_1.default.readFile(filePath);
    const name = options?.filename ?? node_path_1.default.basename(filePath);
    const contentType = options?.contentType ?? 'application/octet-stream';
    const uploadToken = await uploadBufferToMax(token, 'file', buffer, name, contentType);
    await postMessage(token, chatId, {
        text: caption.substring(0, 1024) || '\u00a0',
        attachments: [{ type: 'file', payload: { token: uploadToken } }],
    });
}
async function sendPhotoToMax(token, chatId, photoUrl, caption) {
    const response = await axios_1.default.get(photoUrl, { responseType: 'arraybuffer' });
    const buffer = Buffer.from(response.data);
    const uploadToken = await uploadBufferToMax(token, 'image', buffer, 'photo.jpg', 'image/jpeg');
    await postMessage(token, chatId, {
        text: caption.substring(0, 1024) || '\u00a0',
        attachments: [{ type: 'image', payload: { token: uploadToken } }],
    });
}
async function sendVideoToMax(token, chatId, videoUrl, caption) {
    const response = await axios_1.default.get(videoUrl, { responseType: 'arraybuffer' });
    const buffer = Buffer.from(response.data);
    const name = guessFilenameFromUrl(videoUrl, 'video.mp4');
    const ext = node_path_1.default.extname(name).toLowerCase();
    const filename = ext === '.mp4' || ext === '.webm' || ext === '.mov' ? name : `${name}.mp4`;
    const contentType = ext === '.webm' ? 'video/webm' : ext === '.mov' ? 'video/quicktime' : 'video/mp4';
    const uploadToken = await uploadBufferToMax(token, 'video', buffer, filename, contentType);
    await postMessage(token, chatId, {
        text: caption.substring(0, 1024) || '\u00a0',
        attachments: [{ type: 'video', payload: { token: uploadToken } }],
    });
}
async function sendDocumentToMax(token, chatId, documentUrl, caption, options) {
    const response = await axios_1.default.get(documentUrl, { responseType: 'arraybuffer' });
    const buffer = Buffer.from(response.data);
    const name = options?.filename ?? guessFilenameFromUrl(documentUrl, 'file.bin');
    const contentType = options?.contentType ?? 'application/octet-stream';
    const uploadToken = await uploadBufferToMax(token, 'file', buffer, name, contentType);
    await postMessage(token, chatId, {
        text: caption.substring(0, 1024) || '\u00a0',
        attachments: [{ type: 'file', payload: { token: uploadToken } }],
    });
}
function guessFilenameFromUrl(url, fallback) {
    try {
        const u = new URL(url);
        const base = node_path_1.default.basename(u.pathname);
        if (base && base !== '/' && base !== '') {
            return decodeURIComponent(base);
        }
    }
    catch {
        /* ignore */
    }
    return fallback;
}
//# sourceMappingURL=maxPublisher.js.map