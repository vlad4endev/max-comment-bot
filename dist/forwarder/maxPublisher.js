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
const MAX_API = 'https://botapi.max.ru';
async function sendTextToMax(token, chatId, text) {
    await axios_1.default.post(`${MAX_API}/messages/sendMessage`, {
        token,
        chat_id: chatId,
        text: text.substring(0, 4096),
    });
}
async function sendPhotoFileToMax(token, chatId, filePath, caption) {
    const buffer = await promises_1.default.readFile(filePath);
    const form = new form_data_1.default();
    form.append('token', token);
    form.append('chat_id', chatId);
    form.append('caption', caption.substring(0, 1024));
    form.append('photo', buffer, { filename: node_path_1.default.basename(filePath), contentType: 'image/jpeg' });
    await axios_1.default.post(`${MAX_API}/messages/sendPhoto`, form, { headers: form.getHeaders() });
}
async function sendVideoFileToMax(token, chatId, filePath, caption) {
    const buffer = await promises_1.default.readFile(filePath);
    const name = node_path_1.default.basename(filePath);
    const ext = node_path_1.default.extname(name).toLowerCase();
    const contentType = ext === '.webm' ? 'video/webm' : ext === '.mov' ? 'video/quicktime' : 'video/mp4';
    const form = new form_data_1.default();
    form.append('token', token);
    form.append('chat_id', chatId);
    form.append('caption', caption.substring(0, 1024));
    form.append('video', buffer, { filename: name, contentType });
    await axios_1.default.post(`${MAX_API}/messages/sendVideo`, form, { headers: form.getHeaders() });
}
async function sendDocumentFileToMax(token, chatId, filePath, caption, options) {
    const buffer = await promises_1.default.readFile(filePath);
    const name = options?.filename ?? node_path_1.default.basename(filePath);
    const contentType = options?.contentType ?? 'application/octet-stream';
    const form = new form_data_1.default();
    form.append('token', token);
    form.append('chat_id', chatId);
    form.append('caption', caption.substring(0, 1024));
    form.append('document', buffer, { filename: name, contentType });
    await axios_1.default.post(`${MAX_API}/messages/sendDocument`, form, { headers: form.getHeaders() });
}
async function sendPhotoToMax(token, chatId, photoUrl, caption) {
    // Download photo from Telegram
    const response = await axios_1.default.get(photoUrl, { responseType: 'arraybuffer' });
    const buffer = Buffer.from(response.data);
    const form = new form_data_1.default();
    form.append('token', token);
    form.append('chat_id', chatId);
    form.append('caption', caption.substring(0, 1024));
    form.append('photo', buffer, { filename: 'photo.jpg', contentType: 'image/jpeg' });
    await axios_1.default.post(`${MAX_API}/messages/sendPhoto`, form, {
        headers: form.getHeaders(),
    });
}
async function sendVideoToMax(token, chatId, videoUrl, caption) {
    const response = await axios_1.default.get(videoUrl, { responseType: 'arraybuffer' });
    const buffer = Buffer.from(response.data);
    const name = guessFilenameFromUrl(videoUrl, 'video.mp4');
    const ext = node_path_1.default.extname(name).toLowerCase();
    const filename = ext === '.mp4' || ext === '.webm' || ext === '.mov' ? name : `${name}.mp4`;
    const contentType = ext === '.webm' ? 'video/webm' : ext === '.mov' ? 'video/quicktime' : 'video/mp4';
    const form = new form_data_1.default();
    form.append('token', token);
    form.append('chat_id', chatId);
    form.append('caption', caption.substring(0, 1024));
    form.append('video', buffer, { filename, contentType });
    await axios_1.default.post(`${MAX_API}/messages/sendVideo`, form, {
        headers: form.getHeaders(),
    });
}
async function sendDocumentToMax(token, chatId, documentUrl, caption, options) {
    const response = await axios_1.default.get(documentUrl, { responseType: 'arraybuffer' });
    const buffer = Buffer.from(response.data);
    const name = options?.filename ?? guessFilenameFromUrl(documentUrl, 'file.bin');
    const contentType = options?.contentType ?? 'application/octet-stream';
    const form = new form_data_1.default();
    form.append('token', token);
    form.append('chat_id', chatId);
    form.append('caption', caption.substring(0, 1024));
    form.append('document', buffer, { filename: name, contentType });
    await axios_1.default.post(`${MAX_API}/messages/sendDocument`, form, {
        headers: form.getHeaders(),
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