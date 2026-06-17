"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.readMtprotoConfigFile = readMtprotoConfigFile;
exports.writeMtprotoConfigFile = writeMtprotoConfigFile;
exports.clearMtprotoSession = clearMtprotoSession;
exports.deleteMtprotoConfigFile = deleteMtprotoConfigFile;
exports.resolveMtprotoCredentials = resolveMtprotoCredentials;
exports.isMtprotoSessionReady = isMtprotoSessionReady;
exports.maskPhone = maskPhone;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const CONFIG_PATH = (0, node_path_1.join)(process.cwd(), 'data', 'mtproto-config.json');
function ensureDataDir() {
    const dir = (0, node_path_1.dirname)(CONFIG_PATH);
    if (!(0, node_fs_1.existsSync)(dir)) {
        (0, node_fs_1.mkdirSync)(dir, { recursive: true });
    }
}
function readMtprotoConfigFile() {
    if (!(0, node_fs_1.existsSync)(CONFIG_PATH)) {
        return null;
    }
    try {
        const raw = (0, node_fs_1.readFileSync)(CONFIG_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        const apiId = typeof parsed.apiId === 'number' ? parsed.apiId : Number.parseInt(String(parsed.apiId ?? ''), 10);
        const apiHash = typeof parsed.apiHash === 'string' ? parsed.apiHash.trim() : '';
        const session = typeof parsed.session === 'string' ? parsed.session.trim() : '';
        if (!Number.isFinite(apiId) || !apiHash) {
            return null;
        }
        return {
            apiId,
            apiHash,
            session,
            phone: typeof parsed.phone === 'string' ? parsed.phone : undefined,
            userId: typeof parsed.userId === 'string' ? parsed.userId : undefined,
            userDisplay: typeof parsed.userDisplay === 'string' ? parsed.userDisplay : undefined,
            updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : undefined,
        };
    }
    catch {
        return null;
    }
}
function writeMtprotoConfigFile(patch) {
    ensureDataDir();
    const prev = readMtprotoConfigFile();
    const apiId = typeof patch.apiId === 'number' && Number.isFinite(patch.apiId)
        ? patch.apiId
        : prev?.apiId ?? NaN;
    const apiHash = patch.apiHash !== undefined ? patch.apiHash.trim() : (prev?.apiHash ?? '');
    const session = patch.session !== undefined ? patch.session.trim() : (prev?.session ?? '');
    if (!Number.isFinite(apiId) || !apiHash) {
        throw new Error('Нужны api_id и api_hash');
    }
    const next = {
        apiId,
        apiHash,
        session,
        phone: patch.phone !== undefined ? patch.phone : prev?.phone,
        userId: patch.userId !== undefined ? patch.userId : prev?.userId,
        userDisplay: patch.userDisplay !== undefined ? patch.userDisplay : prev?.userDisplay,
        updatedAt: new Date().toISOString(),
    };
    (0, node_fs_1.writeFileSync)(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8');
    return next;
}
function clearMtprotoSession() {
    const prev = readMtprotoConfigFile();
    if (!prev) {
        return;
    }
    writeMtprotoConfigFile({
        ...prev,
        session: '',
        phone: undefined,
        userId: undefined,
        userDisplay: undefined,
    });
}
function deleteMtprotoConfigFile() {
    if ((0, node_fs_1.existsSync)(CONFIG_PATH)) {
        (0, node_fs_1.unlinkSync)(CONFIG_PATH);
    }
}
function envApiId() {
    const raw = (process.env.TG_API_ID || '').trim();
    if (!raw)
        return null;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
}
function envApiHash() {
    return (process.env.TG_API_HASH || '').trim();
}
function envSession() {
    return (process.env.TG_USER_SESSION || '').trim();
}
function resolveMtprotoCredentials() {
    const file = readMtprotoConfigFile();
    const fromEnv = {
        apiId: envApiId(),
        apiHash: envApiHash(),
        session: envSession(),
    };
    const apiId = file?.apiId ?? fromEnv.apiId;
    const apiHash = file?.apiHash || fromEnv.apiHash;
    const session = file?.session || fromEnv.session;
    const fileUsed = !!(file?.apiId && file.apiHash);
    const envUsed = !!(fromEnv.apiId && fromEnv.apiHash) || !!fromEnv.session;
    let source = 'none';
    if (fileUsed && envUsed) {
        source = 'mixed';
    }
    else if (fileUsed) {
        source = 'file';
    }
    else if (envUsed) {
        source = 'env';
    }
    return { apiId: apiId ?? null, apiHash, session, source };
}
/** User-сессия из админки (data/mtproto-config.json) или .env — для MTProto API. */
function isMtprotoSessionReady() {
    const { apiId, apiHash, session } = resolveMtprotoCredentials();
    return apiId !== null && apiHash !== '' && session !== '';
}
function maskPhone(phone) {
    const p = phone.trim();
    if (p.length <= 4)
        return '••••';
    return `${p.slice(0, Math.min(4, p.length))}•••${p.slice(-2)}`;
}
//# sourceMappingURL=mtprotoConfigStore.js.map