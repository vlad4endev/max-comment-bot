import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { logger } from '../utils/logger'
import { transferPostCommentMappingsChainId } from '../services/postCommentMappingStore'
import {
  ensureAntispamStoreLoaded,
  getAntispamEngineSync as getEngineFromStore,
  getAntispamRulesSync as getRulesFromStore,
  getGlobalStopwordsSync as getGlobalWordsFromStore,
  getScoredWordsSync as getScoredWordsFromStore,
  saveScoredWordsToStore,
  getChannelAntispamSettingsSync,
  isAntispamRestrictedUserSync as isRestrictedFromStore,
  getAntispamWordsSnapshot,
  saveAntispamEngineToStore,
  saveAntispamWordsToStore,
  saveChannelAntispamSettings,
  restrictAntispamUserInStore,
  pushAntispamLogToStore,
  listAntispamLogFromStore,
  purgeAntispamChannelData,
  countAntispamBlocksTodayFromStore,
} from '../services/antispamStore'

const STATE_PATH = join(process.cwd(), 'data', 'admin-panel-state.json')

export interface AntispamRules {
  block_links: boolean
  flood_protection: boolean
  caps_protection: boolean
  emoji_spam: boolean
}

/** Параметры скорингового движка (порт antispam_v16 из n8n). */
export interface AntispamEngineConfig {
  /** true = только журнал, комментарии не блокируются */
  soft_mode: boolean
  enabled: boolean
  spam_threshold: number
  ban_threshold: number
  captcha_required_score: number
  emoji_overuse_limit: number
  whitelist_user_ids: number[]
  blacklist_user_ids: number[]
}

const DEFAULT_ENGINE_CONFIG: AntispamEngineConfig = {
  soft_mode: false,
  enabled: true,
  spam_threshold: 20,
  ban_threshold: 100,
  captcha_required_score: 15,
  emoji_overuse_limit: 20,
  whitelist_user_ids: [685859062],
  blacklist_user_ids: [],
}

export interface ChannelAdminExtras {
  button_text: string
  welcome_message: string
  notify_admin: boolean
  show_reactions: boolean
  moderation_mode: boolean
  stopwords: string[]
  block_links: boolean
  flood_protection: boolean
  auto_mute: boolean
}

export interface VkChainRecord {
  id: string
  /** ID канала MAX, с которым связана VK-группа. */
  max_chat_id: number
  max_title: string | null
  /** ID сообщества VK (без минуса, например "12345678"). */
  vk_group_id: string
  /** Короткий адрес сообщества (screen_name), например "ostrovskidok". */
  vk_screen_name?: string
  /** Название сообщества из VK API. */
  vk_name?: string
  /** User-токен VK с правами wall + photos (+ comments для синка). Токен сообщества не умеет загружать фото. */
  vk_token: string
  /** Публиковать посты канала MAX на стену VK (хук onMaxPostPublished). */
  forward_posts: boolean
  /** Синхронизировать комментарии VK ↔ MAX miniapp. */
  sync_comments: boolean
  active: boolean
  created_at: string
  forwarded_today: number
  errors_today: number
}

export interface TgChainRecord {
  id: string
  max_chat_id: number
  max_title: string | null
  tg_username: string
  /** Числовой ID TG-канала (-100…), если выбран из списка интеграции */
  tg_channel_id?: string
  bot_token: string
  forward_posts: boolean
  /** ISO: пересылать только посты, опубликованные в TG после этого момента. */
  forward_posts_since?: string | null
  forward_comments: boolean
  /** Явный ID чата обсуждений TG (-100…); если пусто — linked_chat_id канала. */
  tg_discussion_chat_id?: string | null
  /** От чьего имени публиковать ответы MAX → TG: канал или группа обсуждений (аноним). */
  tg_discussion_send_as?: 'channel' | 'chat'
  /** Ключевые слова/фразы: обычные комментарии TG синхронизируются только при совпадении. */
  comment_sync_keywords?: string[]
  /** Режим сопоставления слов: contains | equals | word | starts_with | ends_with. */
  comment_sync_match_mode?: 'contains' | 'equals' | 'word' | 'starts_with' | 'ends_with'
  /** Кнопка «Комментарии» под постом в MAX после пересылки */
  add_comments_button: boolean
  add_signature: boolean
  active: boolean
  /** ISO-время автопаузы (бот потерял админ-права в TG); снимается при восстановлении. */
  auto_paused_at?: string | null
  created_at: string
  forwarded_today: number
  errors_today: number
  /** Профиль владельца (MAX + Telegram) в SQLite */
  owner_profile_id?: string
  created_via?: 'admin' | 'miniapp_link'
  max_user_id?: number
  tg_user_id?: number
}

export interface AutopostRecord {
  id: string
  chat_id: number
  channel_title: string | null
  text: string
  scheduled_at: string
  repeat: 'none' | 'daily' | 'weekly' | 'monthly'
  status: 'scheduled' | 'sent' | 'failed'
  created_at: string
}

export interface AntispamLogEntry {
  id: string
  user_id: number
  username: string | null
  channel_chat_id: number
  channel_title: string | null
  reason: string
  text: string
  created_at: string
  spam_score?: number
  action?: string
  source?: string
  categories?: string[]
}

interface StateFile {
  global_stopwords: string[]
  antispam_rules: AntispamRules
  antispam_engine: AntispamEngineConfig
  /** Пользователи, заблокированные антиспамом (auto_mute / ban). */
  antispam_restricted_users: number[]
  antispam_log: AntispamLogEntry[]
  channel_extras: Record<string, ChannelAdminExtras>
  tg_chains: TgChainRecord[]
  vk_chains: VkChainRecord[]
  autoposts: AutopostRecord[]
}

const DEFAULT_RULES: AntispamRules = {
  block_links: true,
  flood_protection: true,
  caps_protection: false,
  emoji_spam: false,
}

const DEFAULT_CHANNEL_EXTRAS: ChannelAdminExtras = {
  button_text: '💬 Комментарии',
  welcome_message: '',
  notify_admin: true,
  show_reactions: true,
  moderation_mode: false,
  stopwords: [],
  block_links: true,
  flood_protection: true,
  auto_mute: false,
}

function normalizeChatId(value: unknown): string | null {
  if (value === null || value === undefined || value === '') {
    return null
  }
  const str = String(value).trim()
  return str === '' ? null : str
}

function normalizeTgChainDiscussionIds(chains: TgChainRecord[]): boolean {
  let needsPersist = false
  for (const chain of chains) {
    const raw = chain.tg_discussion_chat_id as unknown
    if (typeof raw === 'number') {
      chain.tg_discussion_chat_id = String(raw)
      needsPersist = true
      continue
    }
    if (raw !== undefined && raw !== null && raw !== chain.tg_discussion_chat_id) {
      const normalized = normalizeChatId(raw)
      if (normalized !== chain.tg_discussion_chat_id) {
        chain.tg_discussion_chat_id = normalized
        needsPersist = true
      }
    }
  }
  return needsPersist
}

function defaultState(): StateFile {
  return {
    global_stopwords: [],
    antispam_rules: { ...DEFAULT_RULES },
    antispam_engine: { ...DEFAULT_ENGINE_CONFIG },
    antispam_restricted_users: [],
    antispam_log: [],
    channel_extras: {},
    tg_chains: [],
    vk_chains: [],
    autoposts: [],
  }
}

function parseEngineConfig(raw: unknown): AntispamEngineConfig {
  if (typeof raw !== 'object' || raw === null) {
    return { ...DEFAULT_ENGINE_CONFIG }
  }
  const o = raw as Record<string, unknown>
  const whitelist = Array.isArray(o.whitelist_user_ids)
    ? o.whitelist_user_ids.filter((id): id is number => typeof id === 'number' && id > 0)
    : DEFAULT_ENGINE_CONFIG.whitelist_user_ids
  const blacklist = Array.isArray(o.blacklist_user_ids)
    ? o.blacklist_user_ids.filter((id): id is number => typeof id === 'number' && id > 0)
    : []
  return {
    soft_mode: typeof o.soft_mode === 'boolean' ? o.soft_mode : DEFAULT_ENGINE_CONFIG.soft_mode,
    enabled: typeof o.enabled === 'boolean' ? o.enabled : DEFAULT_ENGINE_CONFIG.enabled,
    spam_threshold:
      typeof o.spam_threshold === 'number' ? o.spam_threshold : DEFAULT_ENGINE_CONFIG.spam_threshold,
    ban_threshold:
      typeof o.ban_threshold === 'number' ? o.ban_threshold : DEFAULT_ENGINE_CONFIG.ban_threshold,
    captcha_required_score:
      typeof o.captcha_required_score === 'number'
        ? o.captcha_required_score
        : DEFAULT_ENGINE_CONFIG.captcha_required_score,
    emoji_overuse_limit:
      typeof o.emoji_overuse_limit === 'number'
        ? o.emoji_overuse_limit
        : DEFAULT_ENGINE_CONFIG.emoji_overuse_limit,
    whitelist_user_ids: whitelist,
    blacklist_user_ids: blacklist,
  }
}

let cache: StateFile | null = null
let loadPromise: Promise<StateFile> | null = null

async function loadState(): Promise<StateFile> {
  if (cache) {
    return cache
  }
  if (loadPromise) {
    return loadPromise
  }
  loadPromise = (async () => {
    try {
      const raw = await readFile(STATE_PATH, 'utf8')
      const parsed = JSON.parse(raw) as Partial<StateFile>
      cache = {
        ...defaultState(),
        ...parsed,
        antispam_rules: { ...DEFAULT_RULES, ...(parsed.antispam_rules ?? {}) },
        antispam_engine: parseEngineConfig(parsed.antispam_engine),
        antispam_restricted_users: Array.isArray(parsed.antispam_restricted_users)
          ? parsed.antispam_restricted_users.filter(
              (id): id is number => typeof id === 'number' && id > 0,
            )
          : [],
        global_stopwords: Array.isArray(parsed.global_stopwords) ? parsed.global_stopwords : [],
        antispam_log: Array.isArray(parsed.antispam_log) ? parsed.antispam_log : [],
        channel_extras:
          typeof parsed.channel_extras === 'object' && parsed.channel_extras !== null
            ? parsed.channel_extras
            : {},
        tg_chains: Array.isArray(parsed.tg_chains) ? parsed.tg_chains : [],
        vk_chains: Array.isArray(parsed.vk_chains) ? parsed.vk_chains : [],
        autoposts: Array.isArray(parsed.autoposts) ? parsed.autoposts : [],
      }
      const needsPersist = normalizeTgChainDiscussionIds(cache.tg_chains)
      if (needsPersist) {
        await persist()
      }
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      if (err.code !== 'ENOENT') {
        logger.warn('adminPanelState: read failed, using defaults', e)
      }
      cache = defaultState()
    }
    return cache
  })()
  return loadPromise
}

async function persist(): Promise<void> {
  if (!cache) {
    return
  }
  await mkdir(dirname(STATE_PATH), { recursive: true })
  await writeFile(STATE_PATH, JSON.stringify(cache, null, 2), 'utf8')
}

export async function getAdminPanelState(): Promise<StateFile> {
  return loadState()
}

export async function getAntispamWords(): Promise<{
  global: string[]
  byChannel: Record<string, string[]>
  rules: AntispamRules
  engine: AntispamEngineConfig
  restricted_users: number[]
  scored_words: import('../db/seedAntispamScoredWords').ScoredWordsByScore
  scored_words_total: number
}> {
  await loadState()
  return getAntispamWordsSnapshot()
}

export function getAntispamEngineSync(): AntispamEngineConfig {
  ensureAntispamStoreLoaded()
  return getEngineFromStore()
}

export function getAntispamRulesSync(): AntispamRules {
  ensureAntispamStoreLoaded()
  return getRulesFromStore()
}

export function getGlobalStopwordsSync(): string[] {
  ensureAntispamStoreLoaded()
  return getGlobalWordsFromStore()
}

export function getScoredWordsSync(): import('../db/seedAntispamScoredWords').ScoredWordsByScore {
  ensureAntispamStoreLoaded()
  return getScoredWordsFromStore()
}

export async function saveScoredWords(
  dict: import('../db/seedAntispamScoredWords').ScoredWordsByScore,
): Promise<import('../db/seedAntispamScoredWords').ScoredWordsByScore> {
  await loadState()
  return saveScoredWordsToStore(dict)
}

export function getChannelExtrasSync(chatId: number): ChannelAdminExtras {
  if (!cache) {
    ensureAntispamStoreLoaded()
    const antispam = getChannelAntispamSettingsSync(chatId)
    return {
      ...DEFAULT_CHANNEL_EXTRAS,
      stopwords: antispam.stopwords,
      block_links: antispam.block_links ?? DEFAULT_CHANNEL_EXTRAS.block_links,
      flood_protection: antispam.flood_protection ?? DEFAULT_CHANNEL_EXTRAS.flood_protection,
      auto_mute: antispam.auto_mute,
    }
  }
  const row = cache.channel_extras[String(chatId)]
  const antispam = getChannelAntispamSettingsSync(chatId)
  const base = row ? { ...DEFAULT_CHANNEL_EXTRAS, ...row } : { ...DEFAULT_CHANNEL_EXTRAS }
  return {
    ...base,
    stopwords: antispam.stopwords,
    block_links: antispam.block_links ?? base.block_links,
    flood_protection: antispam.flood_protection ?? base.flood_protection,
    auto_mute: antispam.auto_mute,
  }
}

export function isAntispamRestrictedUserSync(userId: number): boolean {
  ensureAntispamStoreLoaded()
  return isRestrictedFromStore(userId)
}

export async function saveAntispamEngine(patch: Partial<AntispamEngineConfig>): Promise<AntispamEngineConfig> {
  await loadState()
  const saved = saveAntispamEngineToStore(patch)
  if (cache) {
    cache.antispam_engine = { ...saved }
  }
  return saved
}

export async function restrictAntispamUser(userId: number): Promise<void> {
  await loadState()
  restrictAntispamUserInStore(userId)
  if (cache && !cache.antispam_restricted_users.includes(userId)) {
    cache.antispam_restricted_users.push(userId)
  }
}

export async function saveAntispamWords(input: {
  global?: string[]
  rules?: Partial<AntispamRules>
}): Promise<void> {
  await loadState()
  saveAntispamWordsToStore(input)
  if (cache) {
    if (input.global) {
      cache.global_stopwords = input.global.map((w) => w.trim().toLowerCase()).filter(Boolean)
    }
    if (input.rules) {
      cache.antispam_rules = { ...cache.antispam_rules, ...input.rules }
    }
  }
}

export async function getAntispamLog(limit: number): Promise<AntispamLogEntry[]> {
  await loadState()
  return listAntispamLogFromStore(limit)
}

export async function pushAntispamLog(entry: Omit<AntispamLogEntry, 'id' | 'created_at'>): Promise<void> {
  await loadState()
  const row = pushAntispamLogToStore(entry)
  if (cache) {
    cache.antispam_log.unshift(row)
    if (cache.antispam_log.length > 500) {
      cache.antispam_log.length = 500
    }
  }
}

export async function getChannelExtras(chatId: number): Promise<ChannelAdminExtras> {
  await loadState()
  return getChannelExtrasSync(chatId)
}

export async function saveChannelExtras(chatId: number, patch: Partial<ChannelAdminExtras>): Promise<ChannelAdminExtras> {
  const s = await loadState()
  const key = String(chatId)
  const antispamPatch: Parameters<typeof saveChannelAntispamSettings>[1] = {}
  if (patch.stopwords) {
    antispamPatch.stopwords = patch.stopwords
  }
  if (patch.block_links !== undefined) {
    antispamPatch.block_links = patch.block_links
  }
  if (patch.flood_protection !== undefined) {
    antispamPatch.flood_protection = patch.flood_protection
  }
  if (patch.auto_mute !== undefined) {
    antispamPatch.auto_mute = patch.auto_mute
  }
  if (Object.keys(antispamPatch).length > 0) {
    saveChannelAntispamSettings(chatId, antispamPatch)
  }

  const current = s.channel_extras[key] ?? { ...DEFAULT_CHANNEL_EXTRAS }
  const {
    stopwords: _sw,
    block_links: _bl,
    flood_protection: _fp,
    auto_mute: _am,
    ...uiPatch
  } = patch
  const nextUi = { ...DEFAULT_CHANNEL_EXTRAS, ...current, ...uiPatch }
  s.channel_extras[key] = nextUi
  await persist()
  return getChannelExtrasSync(chatId)
}

export interface TgChainHealth {
  last_forwarded_at: string | null
  errors_today: number
  since_too_fresh: string | null
}

export function buildTgChainHealth(
  chain: TgChainRecord,
  lastForwardedAt: string | null,
): TgChainHealth {
  const sinceTooFresh =
    chain.forward_posts &&
    chain.forwarded_today === 0 &&
    chain.forward_posts_since?.trim() &&
    Date.now() - new Date(chain.forward_posts_since).getTime() < 3600_000
      ? 'forward_posts_since выставлен менее часа назад — посты до этого времени пропускаются'
      : null

  return {
    last_forwarded_at: lastForwardedAt,
    errors_today: chain.errors_today ?? 0,
    since_too_fresh: sinceTooFresh,
  }
}

export async function listTgChains(): Promise<TgChainRecord[]> {
  const s = await loadState()
  return [...s.tg_chains]
}

/** In-memory snapshot for hot paths (poller, webhook); call {@link ensureAdminPanelStateLoaded} at startup. */
export function listTgChainsSync(): TgChainRecord[] {
  if (!cache) {
    return []
  }
  return [...cache.tg_chains]
}

export async function ensureAdminPanelStateLoaded(): Promise<void> {
  await loadState()
}

export async function createTgChain(input: Omit<TgChainRecord, 'id' | 'created_at' | 'forwarded_today' | 'errors_today'>): Promise<TgChainRecord> {
  const s = await loadState()
  const nowIso = new Date().toISOString()
  const normalizedInput = {
    ...input,
    tg_discussion_chat_id:
      input.tg_discussion_chat_id !== undefined
        ? normalizeChatId(input.tg_discussion_chat_id)
        : input.tg_discussion_chat_id,
  }
  const previousChains = s.tg_chains.filter((c) => {
    if (c.max_chat_id !== normalizedInput.max_chat_id) {
      return false
    }
    const nextTgId = normalizedInput.tg_channel_id?.trim()
    const prevTgId = c.tg_channel_id?.trim()
    if (nextTgId && prevTgId) {
      return nextTgId === prevTgId
    }
    const nextUname = normalizedInput.tg_username.trim().replace(/^@/, '').toLowerCase()
    const prevUname = c.tg_username.trim().replace(/^@/, '').toLowerCase()
    return nextUname !== '' && nextUname === prevUname
  })
  let inheritedForwardSince = normalizedInput.forward_posts_since?.trim() || null
  for (const prev of previousChains) {
    const since = prev.forward_posts_since?.trim()
    if (since && (!inheritedForwardSince || since < inheritedForwardSince)) {
      inheritedForwardSince = since
    }
  }
  const row: TgChainRecord = {
    ...normalizedInput,
    id: randomUUID(),
    created_at: nowIso,
    forward_posts_since:
      normalizedInput.forward_posts !== false
        ? inheritedForwardSince || nowIso
        : (normalizedInput.forward_posts_since ?? null),
    forwarded_today: 0,
    errors_today: 0,
  }
  s.tg_chains.push(row)

  const oldChains = s.tg_chains.filter(
    (c) =>
      c.tg_channel_id === row.tg_channel_id &&
      String(c.max_chat_id) === String(row.max_chat_id) &&
      c.id !== row.id,
  )
  if (oldChains.length > 0) {
    let totalTransferred = 0
    for (const old of oldChains) {
      totalTransferred += transferPostCommentMappingsChainId(old.id, row.id)
    }
    const earliestSince = oldChains
      .map((c) => c.forward_posts_since)
      .filter(Boolean)
      .sort()[0]
    if (earliestSince && !row.forward_posts_since) {
      row.forward_posts_since = earliestSince
    }
    logger.info('[createTgChain] inherited from old chains', {
      newId: row.id,
      oldIds: oldChains.map((c) => c.id),
      transferred: totalTransferred,
      inheritedSince: row.forward_posts_since,
    })
  } else {
    for (const prev of previousChains) {
      const transferred = transferPostCommentMappingsChainId(prev.id, row.id)
      if (transferred > 0) {
        logger.info('[tgChains] transferred mappings from old chain', {
          oldChainId: prev.id,
          newChainId: row.id,
          transferred,
        })
      }
    }
  }
  await persist()
  return row
}

export async function updateTgChain(id: string, patch: Partial<TgChainRecord>): Promise<TgChainRecord | null> {
  const s = await loadState()
  const idx = s.tg_chains.findIndex((c) => c.id === id)
  if (idx < 0) {
    return null
  }
  const prev = s.tg_chains[idx]!
  const nextPatch = { ...patch }
  if (patch.tg_discussion_chat_id !== undefined) {
    nextPatch.tg_discussion_chat_id = normalizeChatId(patch.tg_discussion_chat_id)
  }
  if (patch.forward_posts === true && !prev.forward_posts) {
    // Сбрасываем since ТОЛЬКО если его не было совсем
    if (!prev.forward_posts_since?.trim() && patch.forward_posts_since === undefined) {
      nextPatch.forward_posts_since = new Date().toISOString()
    }
  }
  s.tg_chains[idx] = { ...prev, ...nextPatch, id }
  await persist()
  return s.tg_chains[idx]
}

export async function deleteTgChain(id: string): Promise<boolean> {
  const s = await loadState()
  const before = s.tg_chains.length
  s.tg_chains = s.tg_chains.filter((c) => c.id !== id)
  if (s.tg_chains.length === before) {
    return false
  }
  await persist()
  return true
}

// ── VK chains ────────────────────────────────────────────────────────────────

export async function listVkChains(): Promise<VkChainRecord[]> {
  const s = await loadState()
  return [...s.vk_chains]
}

/** Synchronous snapshot for hot paths — call {@link ensureAdminPanelStateLoaded} at startup. */
export function listVkChainsSync(): VkChainRecord[] {
  if (!cache) {
    return []
  }
  return [...cache.vk_chains]
}

export async function createVkChain(
  input: Omit<VkChainRecord, 'id' | 'created_at' | 'forwarded_today' | 'errors_today'>,
): Promise<VkChainRecord> {
  const s = await loadState()
  const row: VkChainRecord = {
    ...input,
    id: randomUUID(),
    created_at: new Date().toISOString(),
    forwarded_today: 0,
    errors_today: 0,
  }
  s.vk_chains.push(row)
  await persist()
  return row
}

export async function updateVkChain(
  id: string,
  patch: Partial<VkChainRecord>,
): Promise<VkChainRecord | null> {
  const s = await loadState()
  const idx = s.vk_chains.findIndex((c) => c.id === id)
  if (idx < 0) {
    return null
  }
  s.vk_chains[idx] = { ...s.vk_chains[idx], ...patch, id }
  await persist()
  return s.vk_chains[idx]
}

export async function deleteVkChain(id: string): Promise<boolean> {
  const s = await loadState()
  const before = s.vk_chains.length
  s.vk_chains = s.vk_chains.filter((c) => c.id !== id)
  if (s.vk_chains.length === before) {
    return false
  }
  await persist()
  return true
}

export async function listAutoposts(): Promise<AutopostRecord[]> {
  const s = await loadState()
  return [...s.autoposts].sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at))
}

export async function createAutopost(input: Omit<AutopostRecord, 'id' | 'created_at' | 'status'>): Promise<AutopostRecord> {
  const s = await loadState()
  const row: AutopostRecord = {
    ...input,
    id: randomUUID(),
    status: 'scheduled',
    created_at: new Date().toISOString(),
  }
  s.autoposts.push(row)
  await persist()
  return row
}

export async function deleteAutopost(id: string): Promise<boolean> {
  const s = await loadState()
  const before = s.autoposts.length
  s.autoposts = s.autoposts.filter((p) => p.id !== id)
  if (s.autoposts.length === before) {
    return false
  }
  await persist()
  return true
}

export function countAntispamBlocksToday(_log?: AntispamLogEntry[]): number {
  ensureAntispamStoreLoaded()
  return countAntispamBlocksTodayFromStore()
}

/** Удаляет все настройки админки, привязанные к каналу. */
export async function purgeChannelFromAdminState(chatId: number): Promise<void> {
  const s = await loadState()
  const targetAbs = Math.abs(chatId)
  for (const key of Object.keys(s.channel_extras)) {
    const id = Number.parseInt(key, 10)
    if (Number.isInteger(id) && Math.abs(id) === targetAbs) {
      delete s.channel_extras[key]
    }
  }
  s.tg_chains = s.tg_chains.filter((c) => Math.abs(c.max_chat_id) !== targetAbs)
  s.vk_chains = s.vk_chains.filter((c) => Math.abs(c.max_chat_id) !== targetAbs)
  s.autoposts = s.autoposts.filter((p) => Math.abs(p.chat_id) !== targetAbs)
  purgeAntispamChannelData(chatId)
  await persist()
}
