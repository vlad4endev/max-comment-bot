"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LOG_AI_PROVIDER_PRESETS = void 0;
exports.getLogAiPublicConfig = getLogAiPublicConfig;
exports.saveLogAiConfig = saveLogAiConfig;
exports.testLogAiConnection = testLogAiConnection;
exports.analyzeLogs = analyzeLogs;
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const axios_1 = __importDefault(require("axios"));
const adminLogFormat_1 = require("../utils/adminLogFormat");
const logger_1 = require("../utils/logger");
const postLinkAutoRecovery_1 = require("./postLinkAutoRecovery");
const logAiSettingsStore_1 = require("./logAiSettingsStore");
const RUNTIME_LOG_PATH = (0, node_path_1.join)(process.cwd(), 'data', 'runtime.log');
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_BASE_URL = OPENROUTER_BASE_URL;
const OPENROUTER_APP_TITLE = 'MaxComment Admin';
exports.LOG_AI_PROVIDER_PRESETS = {
    openrouter: {
        label: 'OpenRouter',
        base_url: OPENROUTER_BASE_URL,
        default_model: 'openai/gpt-4o-mini',
        models: [
            'openai/gpt-4o-mini',
            'google/gemini-2.5-flash-preview',
            'anthropic/claude-sonnet-4',
            'deepseek/deepseek-chat-v3-0324',
        ],
        docs_url: 'https://openrouter.ai/keys',
    },
    openai: {
        label: 'OpenAI',
        base_url: OPENAI_BASE_URL,
        default_model: 'gpt-4o-mini',
        models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1'],
        docs_url: 'https://platform.openai.com/api-keys',
    },
    custom: {
        label: 'Свой API',
        base_url: '',
        default_model: '',
        models: [],
        docs_url: '',
    },
};
function isOpenRouterBaseUrl(baseUrl) {
    return baseUrl.includes('openrouter.ai');
}
function parseLogAiProvider(raw) {
    if (raw === 'openrouter' || raw === 'openai' || raw === 'custom') {
        return raw;
    }
    return 'openrouter';
}
function defaultBaseUrlForProvider(provider) {
    const preset = exports.LOG_AI_PROVIDER_PRESETS[provider].base_url;
    return preset || DEFAULT_BASE_URL;
}
function resolveBaseUrl(provider, storedBaseUrl) {
    if (provider === 'custom') {
        return storedBaseUrl.trim().replace(/\/+$/, '');
    }
    return defaultBaseUrlForProvider(provider);
}
function readLogAiConfig() {
    const file = logAiSettingsStore_1.logAiSettingsStore.getConfig();
    if (!file || !file.api_key.trim())
        return null;
    const provider = file.provider;
    const preset = exports.LOG_AI_PROVIDER_PRESETS[provider];
    const baseUrl = resolveBaseUrl(provider, file.base_url) || preset.base_url || DEFAULT_BASE_URL;
    const model = file.model.trim() || preset.default_model;
    return { provider, apiKey: file.api_key.trim(), baseUrl, model };
}
function getLogAiPublicConfig() {
    const file = logAiSettingsStore_1.logAiSettingsStore.getConfig();
    const provider = file?.provider ?? 'openrouter';
    const preset = exports.LOG_AI_PROVIDER_PRESETS[provider];
    const cfg = readLogAiConfig();
    return {
        configured: cfg !== null,
        provider,
        provider_label: preset.label,
        model: cfg?.model ?? file?.model ?? preset.default_model,
        base_url: cfg?.baseUrl ?? resolveBaseUrl(provider, file?.base_url ?? '') ?? preset.base_url,
        api_key_preview: logAiSettingsStore_1.logAiSettingsStore.getApiKeyPreview(),
        presets: exports.LOG_AI_PROVIDER_PRESETS,
    };
}
function buildAiRequestHeaders(cfg) {
    const headers = {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
    };
    if (isOpenRouterBaseUrl(cfg.baseUrl)) {
        headers['HTTP-Referer'] = process.env.OPENROUTER_HTTP_REFERER?.trim() || 'https://max-comment-bot.local';
        headers['X-Title'] = process.env.OPENROUTER_APP_TITLE?.trim() || OPENROUTER_APP_TITLE;
    }
    return headers;
}
async function saveLogAiConfig(input) {
    const prev = logAiSettingsStore_1.logAiSettingsStore.getConfig();
    const provider = input.provider ? parseLogAiProvider(input.provider) : (prev?.provider ?? 'openrouter');
    const preset = exports.LOG_AI_PROVIDER_PRESETS[provider];
    const hasNewKey = typeof input.api_key === 'string' && input.api_key.trim() !== '';
    if (!prev && !hasNewKey) {
        throw new Error('api_key required');
    }
    const modelInput = typeof input.model === 'string' ? input.model.trim() : '';
    const model = modelInput || prev?.model || preset.default_model;
    if (!model) {
        throw new Error('model required');
    }
    let baseUrl = preset.base_url;
    if (provider === 'custom') {
        const customBase = typeof input.base_url === 'string' && input.base_url.trim() !== ''
            ? input.base_url.trim()
            : (prev?.base_url ?? '');
        if (!customBase) {
            throw new Error('base_url required for custom provider');
        }
        baseUrl = customBase.replace(/\/+$/, '');
    }
    await logAiSettingsStore_1.logAiSettingsStore.save({
        provider,
        ...(hasNewKey ? { api_key: input.api_key.trim() } : {}),
        base_url: baseUrl,
        model,
    });
    return getLogAiPublicConfig();
}
async function callLogAiChat(cfg, userPrompt, systemPrompt, options) {
    const url = `${cfg.baseUrl}/chat/completions`;
    const body = {
        model: cfg.model,
        temperature: options?.temperature ?? 0,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ],
    };
    if (options?.jsonMode) {
        body.response_format = { type: 'json_object' };
    }
    const response = await axios_1.default.post(url, body, {
        headers: buildAiRequestHeaders(cfg),
        timeout: options?.timeoutMs ?? 45_000,
    });
    const choice = response.data?.choices?.[0]?.message?.content;
    return typeof choice === 'string' ? choice.trim() : '';
}
async function testLogAiConnection() {
    const cfg = readLogAiConfig();
    if (!cfg) {
        throw new Error('LOG_AI_NOT_CONFIGURED');
    }
    try {
        const reply = await callLogAiChat(cfg, 'Ответь одним словом: OK', 'Отвечай кратко, без пояснений.');
        if (!reply) {
            throw new Error('LOG_AI_EMPTY_RESPONSE');
        }
        return { ok: true, reply, model: cfg.model, provider: cfg.provider };
    }
    catch (err) {
        logger_1.logger.error('logAnalysis: test connection failed', err);
        const msg = axios_1.default.isAxiosError(err) && typeof err.response?.data?.error?.message === 'string'
            ? err.response.data.error.message
            : err instanceof Error
                ? err.message
                : 'AI request failed';
        throw new Error(`LOG_AI_REQUEST_FAILED: ${msg}`);
    }
}
async function loadLogEntries(limit, level, filter) {
    let lines = (0, logger_1.getAdminLogTail)(500);
    try {
        const file = await (0, promises_1.readFile)(RUNTIME_LOG_PATH, 'utf8');
        const fromFile = file.split(/\r?\n/).filter((l) => l.trim() !== '');
        if (fromFile.length > lines.length) {
            lines = fromFile.slice(-500);
        }
    }
    catch {
        /* use memory */
    }
    let entries = lines.map(adminLogFormat_1.parseAdminLogLine).filter((e) => e !== null);
    if (level) {
        entries = entries.filter((e) => e.level === level);
    }
    const filterLower = filter.trim().toLowerCase();
    if (filterLower) {
        entries = entries.filter((e) => {
            const hay = `${e.message} ${e.raw}`.toLowerCase();
            return hay.includes(filterLower);
        });
    }
    return entries.slice(-limit);
}
function getDbStatsSnapshot() {
    try {
        const db = require('../db/database').getDb();
        const posts = db.prepare('SELECT COUNT(*) AS n FROM posts').get().n;
        const pendingButtons = db.prepare("SELECT COUNT(*) AS n FROM posts WHERE json_extract(data, '$.button_attach_pending') = 1").get().n;
        const channels = db.prepare('SELECT COUNT(*) AS n FROM channels WHERE active = 1').get().n;
        const comments = db.prepare('SELECT COUNT(*) AS n FROM comments').get().n;
        const subscribers = db.prepare('SELECT COUNT(*) AS n FROM subscribers').get().n;
        const retryQueueSize = require('./commentButtonRetryQueue').getCommentButtonRetryQueueSize();
        return {
            posts,
            pending_buttons: pendingButtons,
            channels,
            comments,
            subscribers,
            retry_queue: retryQueueSize,
            auto_recovery: (0, postLinkAutoRecovery_1.getPostLinkAutoRecoveryStats)(),
        };
    }
    catch (err) {
        logger_1.logger.warn('logAnalysis: db-stats unavailable', err);
        return null;
    }
}
function focusHint(focus) {
    switch (focus) {
        case 'errors':
            return 'Сфокусируйся на ошибках (ERROR) и их причинах.';
        case 'comment_buttons':
            return 'Сфокусируйся на кнопках «Комментарии» на постах: attach_failed, commentButton, commentButtonRetry, pending_buttons.';
        case 'database':
            return 'Сфокусируйся на операциях с БД: postStore, savePost, pending посты, рассинхрон данных.';
        case 'rate_limit':
            return 'Сфокусируйся на rate limit, таймаутах и перегрузке API MAX/Telegram.';
        case 'integrations':
            return 'Сфокусируйся на интеграциях Telegram→MAX, пересылке, webhook и MTProto.';
        default:
            return 'Дай общую картину здоровья проекта.';
    }
}
function serializeEntriesForPrompt(entries) {
    return entries
        .map((e) => {
        const extra = e.extra !== undefined ? `\n  extra: ${(0, adminLogFormat_1.formatAdminLogExtra)(e.extra)}` : '';
        return `[${e.level}] ${e.ts || '—'} ${e.message}${extra}`;
    })
        .join('\n');
}
function buildPrompt(entries, stats, dbStats, focus) {
    const focusText = focusHint(focus);
    const dbBlock = dbStats
        ? JSON.stringify(dbStats, null, 2)
        : 'недоступна';
    return `Ты — опытный инженер поддержки бота МаксКоммент (MAX + Telegram: комментарии к постам, кнопки, синхронизация, антиспам).

Задача: проанализировать логи и метрики БД и составить понятный отчёт на русском языке для администратора без глубоких технических знаний.

${focusText}

Статистика выбранных логов: всего ${stats.total}, INFO ${stats.info}, WARN ${stats.warn}, ERROR ${stats.error}, DEBUG ${stats.debug}.

Метрики БД:
${dbBlock}

Логи (от старых к новым):
${serializeEntriesForPrompt(entries)}

Верни ТОЛЬКО валидный JSON без markdown-обёртки:
{
  "summary": "2-4 предложения простым языком: что происходит с проектом сейчас",
  "health_score": 0-100,
  "status": "ok" | "attention" | "critical",
  "problems": [
    {
      "severity": "critical" | "warning" | "info",
      "title": "краткий заголовок проблемы",
      "description": "что случилось и почему это важно",
      "what_to_do": "конкретные шаги что проверить/исправить",
      "count": число повторений если можно оценить, иначе не указывай
    }
  ],
  "working_well": ["что работает нормально — 1-4 пункта"],
  "recommendations": ["практичные советы на ближайшее время — 2-5 пунктов"]
}

Правила:
- Пиши по-русски, просто и по делу.
- Группируй одинаковые ошибки, не дублируй.
- Если проблем нет — так и скажи, health_score высокий.
- Не выдумывай проблемы, которых нет в логах.
- what_to_do — actionable шаги (куда зайти в админке, что проверить).`;
}
function parseAnalysisJson(raw) {
    const trimmed = raw.trim();
    const jsonText = trimmed.startsWith('```')
        ? trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
        : trimmed;
    const parsed = JSON.parse(jsonText);
    if (typeof parsed !== 'object' || parsed === null) {
        throw new Error('invalid AI response shape');
    }
    const o = parsed;
    const problemsRaw = Array.isArray(o.problems) ? o.problems : [];
    const problems = problemsRaw
        .map((item) => {
        if (typeof item !== 'object' || item === null)
            return null;
        const p = item;
        const severity = p.severity;
        if (severity !== 'critical' && severity !== 'warning' && severity !== 'info')
            return null;
        const title = typeof p.title === 'string' ? p.title.trim() : '';
        const description = typeof p.description === 'string' ? p.description.trim() : '';
        const what_to_do = typeof p.what_to_do === 'string' ? p.what_to_do.trim() : '';
        if (!title || !description)
            return null;
        const count = typeof p.count === 'number' && Number.isFinite(p.count) ? Math.round(p.count) : undefined;
        return { severity, title, description, what_to_do: what_to_do || 'Проверьте связанные записи в логах.', count };
    })
        .filter((p) => p !== null);
    const working_well = (Array.isArray(o.working_well) ? o.working_well : [])
        .filter((x) => typeof x === 'string' && x.trim() !== '')
        .map((x) => x.trim());
    const recommendations = (Array.isArray(o.recommendations) ? o.recommendations : [])
        .filter((x) => typeof x === 'string' && x.trim() !== '')
        .map((x) => x.trim());
    let health_score = typeof o.health_score === 'number' ? Math.round(o.health_score) : 70;
    health_score = Math.max(0, Math.min(100, health_score));
    let status = 'attention';
    if (o.status === 'ok' || o.status === 'attention' || o.status === 'critical') {
        status = o.status;
    }
    else if (health_score >= 85) {
        status = 'ok';
    }
    else if (health_score < 50) {
        status = 'critical';
    }
    const summary = typeof o.summary === 'string' && o.summary.trim() !== '' ? o.summary.trim() : 'Анализ завершён.';
    return { summary, health_score, status, problems, working_well, recommendations };
}
async function analyzeLogs(options = {}) {
    const cfg = readLogAiConfig();
    if (!cfg) {
        throw new Error('LOG_AI_NOT_CONFIGURED');
    }
    const limit = Math.min(Math.max(options.limit ?? 200, 20), 400);
    const level = options.level ?? null;
    const filter = options.filter ?? '';
    const focus = options.focus ?? 'general';
    const entries = await loadLogEntries(limit, level, filter);
    if (!entries.length) {
        return {
            summary: 'Нет записей логов по выбранным фильтрам — анализировать нечего.',
            health_score: 100,
            status: 'ok',
            problems: [],
            working_well: ['Журнал пуст по текущим фильтрам — явных проблем в логах не видно.'],
            recommendations: ['Снимите фильтры или увеличьте лимит строк, если ожидаете события.'],
            analyzed_at: new Date().toISOString(),
            logs_analyzed: 0,
            model: cfg.model,
        };
    }
    const stats = {
        total: entries.length,
        info: entries.filter((e) => e.level === 'INFO').length,
        warn: entries.filter((e) => e.level === 'WARN').length,
        error: entries.filter((e) => e.level === 'ERROR').length,
        debug: entries.filter((e) => e.level === 'DEBUG').length,
    };
    const dbStats = getDbStatsSnapshot();
    const prompt = buildPrompt(entries, stats, dbStats, focus);
    let content = '';
    try {
        content = await callLogAiChat(cfg, prompt, 'Ты аналитик логов бота. Отвечай только валидным JSON на русском языке, без пояснений вне JSON.', { jsonMode: true, timeoutMs: 90_000, temperature: 0.2 });
    }
    catch (err) {
        logger_1.logger.error('logAnalysis: AI request failed', err);
        const msg = axios_1.default.isAxiosError(err) && typeof err.response?.data?.error?.message === 'string'
            ? err.response.data.error.message
            : err instanceof Error
                ? err.message
                : 'AI request failed';
        throw new Error(`LOG_AI_REQUEST_FAILED: ${msg}`);
    }
    if (!content.trim()) {
        throw new Error('LOG_AI_EMPTY_RESPONSE');
    }
    try {
        const parsed = parseAnalysisJson(content);
        return {
            ...parsed,
            analyzed_at: new Date().toISOString(),
            logs_analyzed: entries.length,
            model: cfg.model,
        };
    }
    catch (err) {
        logger_1.logger.error('logAnalysis: parse AI JSON failed', { content: content.slice(0, 500), err });
        throw new Error('LOG_AI_PARSE_FAILED');
    }
}
//# sourceMappingURL=logAnalysisService.js.map