"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.logAiSettingsStore = void 0;
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const logger_1 = require("../utils/logger");
const CONFIG_PATH = (0, node_path_1.join)(process.cwd(), 'data', 'log-ai-config.json');
function parseProvider(raw) {
    if (raw === 'openrouter' || raw === 'openai' || raw === 'custom') {
        return raw;
    }
    return 'openrouter';
}
function maskApiKey(key) {
    const trimmed = key.trim();
    if (trimmed.length <= 4)
        return '••••';
    return `••••••••${trimmed.slice(-4)}`;
}
class LogAiSettingsStore {
    config = null;
    async loadFromDisk() {
        try {
            const raw = await (0, promises_1.readFile)(CONFIG_PATH, 'utf8');
            const parsed = JSON.parse(raw);
            if (typeof parsed !== 'object' || parsed === null) {
                this.config = null;
                return;
            }
            const o = parsed;
            const apiKey = typeof o.api_key === 'string' ? o.api_key.trim() : '';
            const model = typeof o.model === 'string' ? o.model.trim() : '';
            const baseUrl = typeof o.base_url === 'string' ? o.base_url.trim().replace(/\/+$/, '') : '';
            if (!apiKey) {
                this.config = null;
                return;
            }
            this.config = {
                provider: parseProvider(o.provider),
                api_key: apiKey,
                base_url: baseUrl,
                model,
                updated_at: typeof o.updated_at === 'string' ? o.updated_at : new Date().toISOString(),
            };
        }
        catch (err) {
            const code = err?.code;
            if (code === 'ENOENT') {
                this.config = null;
                return;
            }
            logger_1.logger.error('logAiSettingsStore: read failed', err);
            this.config = null;
        }
    }
    getConfig() {
        return this.config;
    }
    getApiKeyPreview() {
        return this.config ? maskApiKey(this.config.api_key) : '';
    }
    isConfigured() {
        return this.config !== null && this.config.api_key.trim() !== '';
    }
    async save(patch) {
        const prev = this.config;
        const apiKey = typeof patch.api_key === 'string' && patch.api_key.trim() !== ''
            ? patch.api_key.trim()
            : (prev?.api_key ?? '');
        if (!apiKey) {
            throw new Error('api_key required');
        }
        const next = {
            provider: patch.provider ?? prev?.provider ?? 'openrouter',
            api_key: apiKey,
            base_url: typeof patch.base_url === 'string'
                ? patch.base_url.trim().replace(/\/+$/, '')
                : (prev?.base_url ?? ''),
            model: typeof patch.model === 'string' ? patch.model.trim() : (prev?.model ?? ''),
            updated_at: new Date().toISOString(),
        };
        if (!next.model) {
            throw new Error('model required');
        }
        if (next.provider === 'custom' && !next.base_url) {
            throw new Error('base_url required for custom provider');
        }
        this.config = next;
        await this.persist();
        logger_1.logger.info('logAiSettingsStore: saved', { provider: next.provider, model: next.model });
        return next;
    }
    async persist() {
        if (!this.config)
            return;
        const dir = (0, node_path_1.dirname)(CONFIG_PATH);
        await (0, promises_1.mkdir)(dir, { recursive: true });
        await (0, promises_1.writeFile)(CONFIG_PATH, `${JSON.stringify(this.config, null, 2)}\n`, 'utf8');
    }
}
exports.logAiSettingsStore = new LogAiSettingsStore();
//# sourceMappingURL=logAiSettingsStore.js.map