    window.__apiBase = String(location.origin || '').replace(/\/+$/, '')
    window.__tgScriptPromise = null

    function loadTelegramWebAppScript() {
      if (window.Telegram && window.Telegram.WebApp) {
        return Promise.resolve(window.Telegram.WebApp)
      }
      if (window.__tgScriptPromise) {
        return window.__tgScriptPromise
      }
      window.__tgScriptPromise = new Promise(function (resolve, reject) {
        var s = document.createElement('script')
        s.src = 'https://telegram.org/js/telegram-web-app.js'
        s.async = true
        s.onload = function () {
          resolve(window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null)
        }
        s.onerror = function () {
          reject(new Error('telegram-web-app.js'))
        }
        document.head.appendChild(s)
      })
      return window.__tgScriptPromise
    }

    function hideMiniappLoading() {
      var el = document.getElementById('miniappLoading')
      if (el) el.classList.add('hidden')
    }

    function fetchWithTimeout(url, options, timeoutMs) {
      var ms = timeoutMs || 8000
      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        return fetch(url, Object.assign({}, options || {}, { signal: AbortSignal.timeout(ms) }))
      }
      return new Promise(function (resolve, reject) {
        var timer = window.setTimeout(function () {
          reject(new Error('timeout'))
        }, ms)
        fetch(url, options || {})
          .then(function (r) {
            window.clearTimeout(timer)
            resolve(r)
          })
          .catch(function (e) {
            window.clearTimeout(timer)
            reject(e)
          })
      })
    }

    function apiUrl(path) {
      var p = path.charAt(0) === '/' ? path : '/' + path
      return (window.__apiBase || '') + p
    }

    var KNOWN_USER_ERRORS = {
      'missing or invalid user_id': 'Не удалось определить ваш профиль. Откройте приложение из бота.',
      'missing or invalid chat_id': 'Канал не найден. Откройте комментарии из поста ещё раз.',
      'missing or invalid user_id or chat_id': 'Не хватает данных для канала. Откройте приложение из бота.',
      'missing or invalid fields': 'Проверьте, что все поля заполнены.',
      'invalid body': 'Не удалось отправить данные. Попробуйте ещё раз.',
      'internal error': 'Сервис временно недоступен. Попробуйте чуть позже.',
      'channel not connected': 'Канал ещё не подключён к боту.',
      'post not found': 'Пост не найден или удалён.',
      post_not_found: 'Пост не найден или удалён.',
      'comment not found': 'Комментарий не найден.',
      'Доступ запрещён': 'Недостаточно прав для этого действия.',
      'Только администраторы могут изменять комментарии': 'Изменять комментарии могут только администраторы.',
      'owner cannot be disabled': 'Владельца канала нельзя отключить.',
      'target user is not a channel admin': 'Этот пользователь не администратор канала.',
      timeout: 'Слишком долго ждём ответ. Проверьте интернет и попробуйте снова.',
      'Failed to fetch': 'Нет связи с сервером. Проверьте интернет.',
      'NetworkError': 'Нет связи с сервером. Проверьте интернет.',
    }

    function logMiniappError(context, raw) {
      if (raw != null && String(raw).trim() !== '') {
        console.warn('[miniapp]' + (context ? ' ' + context + ':' : ''), raw)
      }
    }

    function isTechnicalErrorMessage(msg) {
      var s = String(msg || '').trim()
      if (!s) return true
      if (/^health |^config |api_html|api_invalid|telegram-web-app|max-web-app/i.test(s)) return true
      if (/\b(400|401|403|404|500|502|503)\b/.test(s) && /HTTP|status|error/i.test(s)) return true
      if (/missing or invalid|internal error|invalid body|not found$/i.test(s)) return true
      if (/\.js:|\/api\/|nginx|docker|git pull|compose|JSON|HTML|прокси|контейнер/i.test(s)) return true
      if (/user_id|chat_id|post_id|message_mid|Bridge|WebApp|initData/i.test(s) && /нет|missing|invalid/i.test(s)) {
        return true
      }
      if (/^[a-z0-9_.-]+$/i.test(s) && s.indexOf(' ') < 0 && s.length < 40) return true
      return false
    }

    function formatUserError(raw, fallback) {
      var fb = fallback || 'Что-то пошло не так. Попробуйте ещё раз.'
      var msg = ''
      if (raw == null) return fb
      if (typeof raw === 'object') {
        if (raw.message) msg = String(raw.message)
        else if (raw.error) msg = String(raw.error)
        else msg = String(raw)
      } else {
        msg = String(raw)
      }
      msg = msg.trim()
      if (!msg || msg === 'pending') return fb

      var lower = msg.toLowerCase()
      var key
      for (key in KNOWN_USER_ERRORS) {
        if (Object.prototype.hasOwnProperty.call(KNOWN_USER_ERRORS, key)) {
          if (lower === String(key).toLowerCase() || lower.indexOf(String(key).toLowerCase()) >= 0) {
            return KNOWN_USER_ERRORS[key]
          }
        }
      }

      if (/[а-яё]/i.test(msg) && !isTechnicalErrorMessage(msg)) {
        return msg.length > 160 ? fb : msg
      }

      if (isTechnicalErrorMessage(msg)) {
        logMiniappError('sanitized', msg)
        return fb
      }

      return msg.length > 160 ? fb : msg
    }

    function showBootError(message, fallback) {
      var el = document.getElementById('miniappBootError')
      if (!el) return
      logMiniappError('boot', message)
      el.textContent = formatUserError(message, fallback || 'Не удалось загрузить приложение. Закройте и откройте снова из бота.')
      el.classList.remove('hidden')
    }

    function hideBootError() {
      var el = document.getElementById('miniappBootError')
      if (el) el.classList.add('hidden')
    }

    function isMiniappTelegramRuntime() {
      return !!window.__miniappPreferTelegram
    }

    function hasPostContextInLocation() {
      try {
        var sp = new URLSearchParams(location.search)
        if (sp.get('post_id') && sp.get('chat_id')) return true
        var rawStart = String(sp.get('startapp') || sp.get('start_param') || '').trim()
        if (/^pid_/i.test(rawStart) || /post_id=/i.test(rawStart)) return true
      } catch (e) {}
      var hash = String(location.hash || '').replace(/^#/, '').trim()
      if (/^pid_/i.test(hash)) return true
      if (hash.indexOf('post_id=') >= 0) return true
      return false
    }

    /** Telegram WebView (MAX script also defines `window.WebApp`, so UA/URL must be checked). */
    function isLikelyTelegramWebView() {
      if (isMiniappTelegramRuntime()) return true
      var ua = String(navigator.userAgent || '')
      if (/Telegram/i.test(ua)) return true
      if (/tgWebApp/i.test(String(location.hash || ''))) return true
      try {
        var sp = new URLSearchParams(location.search)
        if (sp.get('platform') === 'telegram') return true
        if (/[?&]tg_/i.test(location.search || '')) return true
      } catch (e) {}
      var tgApi = window.Telegram && window.Telegram.WebApp
      if (!tgApi) return false
      var tgUnsafe = tgApi.initDataUnsafe || {}
      var tgUser = tgUnsafe.user
      if (tgUser && getBridgeNumericUserId(tgUser) != null) return true
      return typeof tgApi.initData === 'string' && tgApi.initData.trim() !== ''
    }

    function parseTelegramInitDataString(raw) {
      if (!raw || typeof raw !== 'string') return null
      try {
        var p = new URLSearchParams(raw.trim())
        var userJson = p.get('user')
        if (!userJson) return null
        return { user: JSON.parse(userJson) }
      } catch (e) {
        return null
      }
    }

    function parseUserFromWebAppHash(hash, dataKey) {
      if (!hash || !dataKey) return null
      try {
        var h = String(hash).replace(/^#/, '')
        var hp = new URLSearchParams(h)
        var data = hp.get(dataKey)
        if (!data) return null
        var inner = new URLSearchParams(data)
        var userStr = inner.get('user')
        if (!userStr) return null
        return JSON.parse(userStr)
      } catch (e) {
        return null
      }
    }

    function getBridgeUserFromHash() {
      var hashes = [location.hash]
      try {
        var nav = performance.getEntriesByType('navigation')[0]
        if (nav && nav.name) {
          var navHash = new URL(nav.name).hash
          if (navHash) hashes.push(navHash)
        }
      } catch (e) {}
      var dataKeys = ['WebAppData', 'tgWebAppData']
      for (var i = 0; i < hashes.length; i++) {
        for (var k = 0; k < dataKeys.length; k++) {
          var user = parseUserFromWebAppHash(hashes[i], dataKeys[k])
          if (user) return user
        }
      }
      return null
    }

    /** MAX mini app host (platform set or MAX SDK loaded), even before initData arrives. */
    function isLikelyMaxMiniapp() {
      if (isMiniappTelegramRuntime()) return false
      if (isLikelyTelegramWebView() && window.Telegram && window.Telegram.WebApp) return false
      var maxApi = window.WebApp
      if (!maxApi || window.__miniappPreferTelegram) return false
      if (getBridgeUserFromHash()) return true
      var maxPlatform =
        typeof maxApi.platform === 'string' ? maxApi.platform.trim().toLowerCase() : ''
      if (maxPlatform === 'ios' || maxPlatform === 'android' || maxPlatform === 'desktop') {
        return true
      }
      if (maxPlatform === 'web') {
        var maxUnsafe = maxApi.initDataUnsafe || {}
        var maxUser = normalizeBridgeUser(maxUnsafe.user || {})
        if (getBridgeNumericUserId(maxUser) != null) return true
        if (typeof maxApi.initData === 'string' && maxApi.initData.trim() !== '') return true
        return typeof maxApi.version === 'string' && maxApi.version.trim() !== ''
      }
      return false
    }

    function tryReadyBridge(bridge) {
      if (!bridge || bridge.__miniappReadyCalled) return
      try {
        if (typeof bridge.ready === 'function') {
          bridge.ready()
          bridge.__miniappReadyCalled = true
        }
      } catch (e) {}
    }

    function syncHomeUserBadge(uid) {
      var badge = document.getElementById('homeUserBadge')
      if (!badge) return
      if (uid != null) {
        badge.textContent = 'Активен'
        badge.classList.remove('hidden')
      } else {
        badge.classList.add('hidden')
      }
    }

    function resolveBridgeUser(bridge) {
      var unsafe = (bridge && bridge.initDataUnsafe) || {}
      var user = normalizeBridgeUser(unsafe.user || {})
      if (getBridgeNumericUserId(user) != null) return user
      if (bridge && typeof bridge.initData === 'string' && bridge.initData.trim() !== '') {
        var fromInit = parseTelegramInitDataString(bridge.initData)
        if (fromInit && fromInit.user) {
          user = normalizeBridgeUser(fromInit.user)
          if (getBridgeNumericUserId(user) != null) return user
        }
      }
      var fromHash = getBridgeUserFromHash()
      if (fromHash) return normalizeBridgeUser(fromHash)
      return user
    }

    function isActiveMaxBridge(maxApi) {
      if (!maxApi || window.__miniappPreferTelegram) return false
      var maxUnsafe = maxApi.initDataUnsafe || {}
      var maxUser = normalizeBridgeUser(maxUnsafe.user || {})
      if (getBridgeNumericUserId(maxUser) != null) return true
      return typeof maxApi.initData === 'string' && maxApi.initData.trim() !== ''
    }

    function isActiveTelegramBridge(tgApi) {
      if (!tgApi) return false
      var tgUnsafe = tgApi.initDataUnsafe || {}
      var tgUser = tgUnsafe.user
      if (tgUser && getBridgeNumericUserId(tgUser) != null) return true
      return typeof tgApi.initData === 'string' && tgApi.initData.trim() !== ''
    }

    /** MAX `window.WebApp` or Telegram `Telegram.WebApp` when opened from TG bot. */
    function getWebAppBridge() {
      var maxApi = window.WebApp
      var tgApi = window.Telegram && window.Telegram.WebApp
      var likelyTg = isLikelyTelegramWebView()

      if (isMiniappTelegramRuntime() || likelyTg) {
        if (tgApi && isActiveTelegramBridge(tgApi)) return tgApi
        if (tgApi) return tgApi
        return null
      }

      if (maxApi && isLikelyMaxMiniapp()) return maxApi

      if (tgApi && isActiveTelegramBridge(tgApi)) return tgApi

      if (likelyTg && tgApi) return tgApi
      return tgApi || maxApi || null
    }

    function isMaxMiniappBridge(bridge) {
      if (isMiniappTelegramRuntime()) return false
      return !!(
        bridge &&
        window.WebApp &&
        bridge === window.WebApp &&
        isLikelyMaxMiniapp()
      )
    }

    function isTelegramMiniappBridge(bridge) {
      if (window.Telegram && window.Telegram.WebApp && bridge === window.Telegram.WebApp) {
        return true
      }
      if (!window.Telegram || !window.Telegram.WebApp) {
        return isMiniappTelegramRuntime() || isLikelyTelegramWebView()
      }
      if (bridge && window.WebApp && bridge === window.WebApp) return false
      return isMiniappTelegramRuntime() || isLikelyTelegramWebView()
    }

    function normalizeBridgeUser(rawUser) {
      if (!rawUser || typeof rawUser !== 'object') return {}
      if (rawUser.user_id == null && rawUser.id != null) {
        return Object.assign({}, rawUser, { user_id: rawUser.id })
      }
      return rawUser
    }

    function openBridgeExternalLink(url) {
      var bridge = getWebAppBridge()
      if (!bridge) {
        window.location.href = url
        return
      }
      try {
        if (typeof bridge.openMaxLink === 'function') {
          bridge.openMaxLink(url)
          return
        }
      } catch (e1) {}
      try {
        if (typeof bridge.openLink === 'function') {
          bridge.openLink(url)
          return
        }
      } catch (e2) {}
      window.location.href = url
    }

    function readStartParamFromWebAppHash(hashKey) {
      try {
        var outer = new URLSearchParams(String(location.hash || '').replace(/^#/, ''))
        var packed = outer.get(hashKey)
        if (!packed) return ''
        var inner = new URLSearchParams(packed)
        return (
          inner.get('start_param') ||
          inner.get('startapp') ||
          inner.get('startApp') ||
          ''
        )
      } catch (e) {
        return ''
      }
    }

    function collectStartParam(unsafe, webApp) {
      var candidates = []
      if (unsafe && typeof unsafe === 'object') {
        candidates.push(unsafe.start_param, unsafe.startapp, unsafe.startApp)
      }
      if (webApp && typeof webApp === 'object') {
        candidates.push(webApp.start_param, webApp.startapp)
      }
      try {
        var sp = new URLSearchParams(location.search)
        candidates.push(sp.get('startapp'), sp.get('start_param'))
      } catch (e) {}
      candidates.push(readStartParamFromWebAppHash('WebAppData'))
      candidates.push(readStartParamFromWebAppHash('tgWebAppData'))
      var hash = String(location.hash || '').replace(/^#/, '').trim()
      if (hash) {
        if (hash.indexOf('=') >= 0) {
          try {
            var hp = new URLSearchParams(hash.indexOf('?') >= 0 ? hash.split('?').pop() : hash)
            candidates.push(hp.get('startapp'), hp.get('start_param'))
          } catch (e2) {}
        } else if (/^pid_/i.test(hash) || /^join\d+$/i.test(hash)) {
          candidates.push(hash)
        }
      }
      for (var i = 0; i < candidates.length; i++) {
        var v = candidates[i]
        if (v != null && String(v).trim() !== '' && String(v).trim() !== 'start') {
          return String(v).trim()
        }
      }
      return ''
    }

    function decodeStartParam(raw) {
      if (!raw || raw === 'start') return null
      var trimmed = String(raw).trim()
      if (/^linkmax$/i.test(trimmed)) {
        return { open_channel_link: true }
      }
      var joinTgMatch = /^jointg(\d+)$/i.exec(trimmed)
      if (joinTgMatch) {
        return { join_channel_id: '-' + joinTgMatch[1], join_platform: 'telegram' }
      }
      var joinMatch = /^join(\d+)$/i.exec(trimmed)
      if (joinMatch) {
        return { join_channel_id: '-' + joinMatch[1], join_platform: 'max' }
      }
      var m = trimmed.match(/^pid_([a-f0-9]+|\d+)_cid_(\d+)(?:_mid_([A-Za-z0-9_-]+))?(_admin)?$/i)
      if (!m) return null
      var id = m[1]
      var postId = null
      if (/^\d+$/.test(id)) {
        postId = id
      } else {
        if (id.length !== 32) return null
        postId = [id.slice(0,8), id.slice(8,12), id.slice(12,16), id.slice(16,20), id.slice(20)].join('-')
      }
      var out = { post_id: postId, chat_id: '-' + m[2], admin: !!m[4] }
      if (m[3]) {
        try {
          var padded = m[3] + '='.repeat((4 - (m[3].length % 4)) % 4)
          var bin = atob(padded.replace(/-/g, '+').replace(/_/g, '/'))
          var mid = ''
          for (var i = 0; i < bin.length; i++) mid += String.fromCharCode(bin.charCodeAt(i))
          if (mid) out.message_mid = mid
        } catch (e) {}
      }
      return out
    }

    /** Same numeric id as MAX API / bot (`user_id`); Bridge may also expose `id`. */
    function getBridgeNumericUserId(bridgeUser) {
      if (!bridgeUser || typeof bridgeUser !== 'object') return null
      var apiId = bridgeUser.user_id
      var bridgeId = bridgeUser.id
      if (typeof apiId === 'number' && apiId > 0) return apiId
      if (typeof bridgeId === 'number' && bridgeId > 0) return bridgeId
      if (typeof apiId === 'string' && /^\d+$/.test(apiId)) {
        var fromApi = parseInt(apiId, 10)
        if (Number.isFinite(fromApi) && fromApi > 0) return fromApi
      }
      if (typeof bridgeId === 'string' && /^\d+$/.test(bridgeId)) {
        var fromBridge = parseInt(bridgeId, 10)
        if (Number.isFinite(fromBridge) && fromBridge > 0) return fromBridge
      }
      return null
    }

    /** Profile photo from MAX WebApp bridge (`photo_url` and fallbacks). */
    function getBridgeUserPhotoUrl(bridgeUser) {
      if (!bridgeUser || typeof bridgeUser !== 'object') return null
      var raw =
        bridgeUser.photo_url ||
        bridgeUser.avatar_url ||
        (bridgeUser.photo &&
          (typeof bridgeUser.photo === 'string'
            ? bridgeUser.photo
            : bridgeUser.photo.url)) ||
        null
      if (typeof raw !== 'string') return null
      var trimmed = raw.trim()
      return trimmed || null
    }

    function isAdminParamValue(value) {
      if (value == null) return false
      var normalized = String(value).trim().toLowerCase()
      return normalized === '1' || normalized === 'true' || normalized === 'yes'
    }

    function buildMergedSearchParams(user, startParam) {
      var sp = new URLSearchParams(location.search);
      var bridgeUser = user;
      var bid = getBridgeNumericUserId(bridgeUser);
      if (bid != null && !sp.get('user_id')) sp.set('user_id', String(bid));
      // Telegram WebApp fallback: when opened from TG bot link, use signed tg_uid
      // as runtime identity so UI/API can work without manual ?user_id.
      if (!sp.get('user_id')) {
        var tgUid = (sp.get('tg_uid') || '').trim();
        if (/^\d+$/.test(tgUid)) {
          sp.set('user_id', tgUid);
        }
      }
      var uname =
        (bridgeUser.username && String(bridgeUser.username).trim()) ||
        (bridgeUser.first_name && String(bridgeUser.first_name).trim()) ||
        '';
      if (uname && !sp.get('username')) sp.set('username', uname);
      var raw = String(startParam || '').trim();
      var fromStart = decodeStartParam(raw);
      if (fromStart) {
        if (fromStart.post_id) sp.set('post_id', fromStart.post_id);
        if (fromStart.chat_id) sp.set('chat_id', fromStart.chat_id);
        if (fromStart.message_mid) sp.set('message_mid', fromStart.message_mid);
        if (fromStart.admin) sp.set('admin', '1');
        if (fromStart.join_channel_id) {
          sp.set('join_channel_id', fromStart.join_channel_id);
        }
      }
      if (raw && raw !== 'start' && raw.indexOf('post_id=') !== -1) {
        var inner = raw.charAt(0) === '?' ? raw.slice(1) : raw;
        try {
          var q2 = new URLSearchParams(inner);
          ['post_id', 'chat_id', 'message_mid', 'user_id', 'username', 'admin', 'subscribers', 'join_channel_id'].forEach(function (k) {
            var v = q2.get(k);
            if (v) sp.set(k, v);
          });
        } catch (e) {}
      }
      return sp;
    }

    function scrollToBottom() {
      var feed = document.getElementById('feed')
      if (feed) {
        feed.scrollTop = feed.scrollHeight
      }
    }

    function showToast(msg, fallback) {
      var t = document.getElementById('toast')
      if (!t) return
      t.textContent = formatUserError(msg, fallback || (msg ? String(msg) : 'Что-то пошло не так'))
      t.style.opacity = '1'
      if (t._toastTimer) window.clearTimeout(t._toastTimer)
      t._toastTimer = window.setTimeout(function () {
        t.style.opacity = '0'
      }, 2000)
    }

    function updateToggleUI() {
      var pref = 'auto'
      if (window.ThemeManager && typeof window.ThemeManager.get === 'function') {
        pref = window.ThemeManager.get() || 'auto'
      }
      if (pref !== 'auto' && pref !== 'light' && pref !== 'dark') pref = 'auto'

      var themeMap = {
        auto: { icon: '✨', label: 'Авто' },
        light: { icon: '☀️', label: 'Светлая' },
        dark: { icon: '🌙', label: 'Тёмная' },
      }
      var config = themeMap[pref] || themeMap.auto
      var iconEl = document.getElementById('themeIcon')
      var labelEl = document.getElementById('themeLabel')
      var toggleEl = document.getElementById('themeToggle')

      if (iconEl) iconEl.textContent = config.icon
      if (labelEl) labelEl.textContent = config.label
      if (toggleEl) {
        toggleEl.dataset.theme = pref
        toggleEl.setAttribute('aria-label', 'Тема: ' + config.label)
      }
    }

    function cycleTheme() {
      var order = ['auto', 'light', 'dark']
      var current = 'auto'
      if (window.ThemeManager && typeof window.ThemeManager.get === 'function') {
        current = window.ThemeManager.get() || 'auto'
      }
      var idx = order.indexOf(current)
      if (idx === -1) idx = 0
      var next = order[(idx + 1) % order.length]

      if (window.ThemeManager && typeof window.ThemeManager.set === 'function') {
        window.ThemeManager.set(next)
      } else {
        document.documentElement.setAttribute('data-theme', next === 'auto' ? 'light' : next)
      }
      updateToggleUI()
    }

    var currentSettingsChatId = null
    var channelsCache = []
    var homeSettingsUid = null

    function openChannelSettings(chatId) {
      currentSettingsChatId = chatId
      var overlay = document.getElementById('settingsOverlay')
      if (!overlay) return
      overlay.style.display = 'flex'
      hideManagerPasteZone()
      wireManagerUrlPasteButton()

      var ch =
        channelsCache.find(function (c) {
          return String(c.chat_id) === String(chatId)
        }) || {}
      var title = (ch.title && String(ch.title).trim()) || 'Канал'
      var nameEl = document.getElementById('settingsChName')
      var avEl = document.getElementById('settingsChAv')
      if (nameEl) nameEl.textContent = title
      if (avEl) {
        var ini = title.trim()
        avEl.textContent =
          ini.length >= 2
            ? ini.slice(0, 2).toUpperCase()
            : ini.slice(0, 1).toUpperCase() || '?'
      }

      var saveStatus = document.getElementById('settingsSaveStatus')
      if (saveStatus) saveStatus.textContent = ''

      var workStatus = document.getElementById('settingsWorkStatus')
      if (workStatus) workStatus.style.display = 'none'

      var uid = homeSettingsUid
      if (uid == null) return

      fetch(
        '/api/channel-settings?chat_id=' +
          encodeURIComponent(String(chatId)) +
          '&user_id=' +
          encodeURIComponent(String(uid))
      )
        .then(function (r) {
          return r.json()
        })
        .then(function (data) {
          var mgr = document.getElementById('settingsManagerUrl')
          var wh = document.getElementById('settingsWorkHours')
          var ws = document.getElementById('settingsWorkStatus')
          if (mgr) mgr.value = data.manager_url || ''
          if (wh) wh.value = data.work_hours || ''
          if (ws && data.is_open !== undefined) {
            ws.style.display = 'block'
            ws.textContent = data.is_open ? '🟢 Сейчас открыто' : '🔴 Сейчас закрыто'
          }
        })
        .catch(function () {})
    }

    function closeChannelSettings() {
      var overlay = document.getElementById('settingsOverlay')
      if (overlay) overlay.style.display = 'none'
      hideManagerPasteZone()
      currentSettingsChatId = null
    }

    function applyManagerUrlText(text) {
      var input = document.getElementById('settingsManagerUrl')
      if (!input) return false
      var t = String(text || '').trim()
      if (!t) return false
      input.value = t
      try {
        input.dispatchEvent(new Event('input', { bubbles: true }))
      } catch (e) {}
      return true
    }

    function showManagerPasteZone() {
      var zone = document.getElementById('settingsPasteZone')
      var helper = document.getElementById('settingsManagerPasteHelper')
      if (zone) zone.classList.add('show')
      if (helper) {
        helper.value = ''
        setTimeout(function () {
          helper.focus()
        }, 80)
      }
    }

    function hideManagerPasteZone() {
      var zone = document.getElementById('settingsPasteZone')
      var helper = document.getElementById('settingsManagerPasteHelper')
      if (zone) zone.classList.remove('show')
      if (helper) helper.value = ''
    }

    function onManagerUrlPasteEvent(e) {
      var text = ''
      if (e && e.clipboardData) {
        text = e.clipboardData.getData('text/plain') || e.clipboardData.getData('text') || ''
      }
      if (!text && e && e.target && e.target.value) {
        text = e.target.value
      }
      if (!applyManagerUrlText(text)) return
      hideManagerPasteZone()
      var input = document.getElementById('settingsManagerUrl')
      if (input) input.focus()
      showToast('Ссылка вставлена')
    }

    function pasteIntoManagerUrlField() {
      var input = document.getElementById('settingsManagerUrl')
      if (!input) return
      showManagerPasteZone()
      if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
        navigator.clipboard
          .readText()
          .then(function (text) {
            if (applyManagerUrlText(text)) {
              hideManagerPasteZone()
              input.focus()
              showToast('Ссылка вставлена')
            }
          })
          .catch(function () {
            showToast('Нажмите в поле ниже → «Вставить»')
          })
        return
      }
      input.focus()
      showToast('Нажмите в поле → «Вставить»')
    }

    function wireManagerUrlPasteButton() {
      var pasteBtn = document.getElementById('settingsManagerPaste')
      if (pasteBtn && pasteBtn.dataset.bound !== '1') {
        pasteBtn.dataset.bound = '1'
        pasteBtn.addEventListener('click', function (e) {
          e.preventDefault()
          pasteIntoManagerUrlField()
        })
      }
      var input = document.getElementById('settingsManagerUrl')
      var helper = document.getElementById('settingsManagerPasteHelper')
      if (input && input.dataset.pasteBound !== '1') {
        input.dataset.pasteBound = '1'
        input.addEventListener('paste', onManagerUrlPasteEvent)
      }
      if (helper && helper.dataset.pasteBound !== '1') {
        helper.dataset.pasteBound = '1'
        helper.addEventListener('paste', onManagerUrlPasteEvent)
        helper.addEventListener('input', function () {
          if (applyManagerUrlText(helper.value)) {
            hideManagerPasteZone()
            showToast('Ссылка вставлена')
          }
        })
      }
    }

    function saveChannelSettings() {
      if (!currentSettingsChatId) return
      var uid = homeSettingsUid
      if (uid == null) return
      var btn = document.getElementById('settingsSaveBtn')
      var status = document.getElementById('settingsSaveStatus')
      if (btn) {
        btn.disabled = true
        btn.textContent = 'Сохранение...'
      }
      if (status) {
        status.textContent = ''
        status.style.color = 'var(--teal)'
      }

      fetch('/api/channel-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: currentSettingsChatId,
          user_id: uid,
          manager_url:
            document.getElementById('settingsManagerUrl').value.trim() || null,
          work_hours: document.getElementById('settingsWorkHours').value.trim() || null,
        }),
      })
        .then(function (r) {
          return r.json().then(function (data) {
            return { ok: r.ok, data: data }
          })
        })
        .then(function (x) {
          if (x.ok && !(x.data && x.data.error)) {
            if (status) status.textContent = '✅ Сохранено!'
            setTimeout(closeChannelSettings, 1200)
          } else if (status) {
            status.textContent =
              '❌ ' + formatUserError((x.data && x.data.error) || '', 'Не удалось сохранить настройки')
            status.style.color = 'var(--danger)'
          }
        })
        .catch(function () {
          if (status) {
            status.textContent = '❌ Ошибка сети'
            status.style.color = 'var(--danger)'
          }
        })
        .finally(function () {
          if (btn) {
            btn.disabled = false
            btn.textContent = 'Сохранить настройки'
          }
        })
    }

    function initApp() {
      window.__miniappReady = true
      hideMiniappLoading()
      var bridge = getWebAppBridge()
      if (!bridge && isMiniappTelegramRuntime() && window.Telegram && window.Telegram.WebApp) {
        bridge = window.Telegram.WebApp
      }
      bridge = bridge || {}
      var inTelegram = isTelegramMiniappBridge(bridge);
      var inMax = isMaxMiniappBridge(bridge);
      try {
        if (typeof bridge.ready === 'function') {
          bridge.ready();
        }
      } catch (eReady) {}
      if (bridge.colorScheme && window.ThemeManager && typeof window.ThemeManager.get === 'function' && window.ThemeManager.get() === 'auto') {
        var bridgeTheme = String(bridge.colorScheme).toLowerCase();
        if (bridgeTheme === 'light' || bridgeTheme === 'dark') {
          document.documentElement.setAttribute('data-theme', bridgeTheme);
        }
      }
      updateToggleUI();
      var themeToggleEl = document.getElementById('themeToggle');
      if (themeToggleEl && themeToggleEl.dataset.bound !== '1') {
        themeToggleEl.dataset.bound = '1';
        themeToggleEl.addEventListener('click', cycleTheme);
      }
      try {
        if (typeof bridge.expand === 'function') {
          bridge.expand();
        }
      } catch (e) {}

      var unsafe = bridge.initDataUnsafe || {};
      var user = resolveBridgeUser(bridge);
      var startParam = collectStartParam(unsafe, bridge);
      var homeDescEl = document.getElementById('homeBotDesc');
      if (homeDescEl) {
        homeDescEl.textContent = inTelegram
          ? 'Бот поможет связать ваш канал в Telegram с каналом в MAX.'
          : 'Комментарии к постам канала в MAX: собирайте обратную связь и отвечайте читателям из одного окна.';
      }

      var mergedParams = buildMergedSearchParams(user, startParam);
      console.info('miniapp: opened', {
        startParam: startParam || null,
        userId: getBridgeNumericUserId(user),
        chatId: mergedParams.get('chat_id'),
        platform: inTelegram ? 'telegram' : inMax ? 'max' : 'unknown',
        preferTelegram: !!window.__miniappPreferTelegram,
      });
      var postId = mergedParams.get('post_id');
      var chatId = mergedParams.get('chat_id');
      var joinChannelId = mergedParams.get('join_channel_id');
      var hasPostContext = !!(postId && chatId);
      var adminParam = isAdminParamValue(mergedParams.get('admin'));

      var viewHome = document.getElementById('view-home');
      var viewComments = document.getElementById('view-comments');
      var viewGate = document.getElementById('view-gate');
      var viewJoin = document.getElementById('view-join');

      if (joinChannelId) {
        viewJoin.classList.remove('hidden');
        viewHome.classList.add('hidden');
        viewComments.classList.add('hidden');
        if (viewGate) viewGate.classList.add('hidden');
      } else if (hasPostContext) {
        viewHome.classList.add('hidden');
        viewJoin.classList.add('hidden');
        viewComments.classList.remove('hidden');
        if (viewGate) viewGate.classList.add('hidden');
      } else {
        viewHome.classList.remove('hidden');
        viewComments.classList.add('hidden');
        viewJoin.classList.add('hidden');
        if (viewGate) viewGate.classList.add('hidden');
      }

    /* ——— JOIN (admin invite) ——— */
    function showJoinPage(channelId) {
      var cid = channelId || joinChannelId;
      if (!cid) return;

      document.querySelectorAll('.view').forEach(function (v) {
        v.classList.add('hidden');
      });
      var viewJoin = document.getElementById('view-join');
      if (viewJoin) viewJoin.classList.remove('hidden');

      var channelNameEl = document.getElementById('joinChannelName');
      if (channelNameEl) channelNameEl.textContent = 'Канал';

      fetch(
        '/api/channel-info?chat_id=' +
          encodeURIComponent(cid) +
          (inTelegram ? '&platform=telegram' : '')
      )
        .then(function (r) {
          return r.json();
        })
        .then(function (data) {
          if (channelNameEl) {
            channelNameEl.textContent = (data && data.title) || 'Канал';
          }
        })
        .catch(function () {});

      fetch('/api/config')
        .then(function (r) {
          return r.json();
        })
        .then(function (cfg) {
          var launchBtn = document.getElementById('joinLaunchBtn');
          if (!launchBtn) return;
          var url = '';
          if (inTelegram) {
            var tgDigits = String(cid).trim().replace(/^-/, '');
            if (!/^\d+$/.test(tgDigits)) return;
            url =
              'https://t.me/commentvmax_bot?start=' + encodeURIComponent('jointg' + tgDigits);
          } else {
            var nick = String((cfg && cfg.bot_nickname) || '').replace(/^@/, '');
            if (!nick) return;
            var absId = Math.abs(parseInt(cid, 10));
            if (!Number.isFinite(absId) || absId <= 0) return;
            url = 'https://max.ru/' + nick + '?start=' + encodeURIComponent('join' + absId);
          }
          launchBtn.href = url;
          launchBtn.onclick = function (e) {
            e.preventDefault();
            openBridgeExternalLink(url);
          };
        })
        .catch(function () {});

      var learnBtn = document.getElementById('joinLearnBtn');
      var howOverlay = document.getElementById('joinHowOverlay');
      var howClose = document.getElementById('joinHowClose');
      if (learnBtn && howOverlay && learnBtn.dataset.bound !== '1') {
        learnBtn.dataset.bound = '1';
        learnBtn.addEventListener('click', function () {
          howOverlay.classList.remove('hidden');
          howOverlay.setAttribute('aria-hidden', 'false');
        });
        if (howClose) {
          howClose.addEventListener('click', function () {
            howOverlay.classList.add('hidden');
            howOverlay.setAttribute('aria-hidden', 'true');
          });
        }
        howOverlay.addEventListener('click', function (e) {
          if (e.target === howOverlay) {
            howOverlay.classList.add('hidden');
            howOverlay.setAttribute('aria-hidden', 'true');
          }
        });
      }
    }

    /* ——— HOME ——— */
    function bootHome() {
      if (hasPostContext || joinChannelId) return;
      var adminBanner = document.getElementById('adminBanner');
      if (adminParam) adminBanner.classList.add('show');

      var homeErr = document.getElementById('homeErr');
      var botNick = '@bot';
      var platformQs = inTelegram ? '&platform=telegram' : '';
      function homeApiHeaders(withJson) {
        var h = withJson ? { 'Content-Type': 'application/json' } : {};
        if (inTelegram) h['X-Miniapp-Platform'] = 'telegram';
        return h;
      }

      function setHomeErr(t, fallback) {
        homeErr.textContent = t ? formatUserError(t, fallback || String(t)) : '';
      }

      function initials(name) {
        var t = String(name || '').trim();
        if (!t) return '?';
        var parts = t.split(/\s+/);
        if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
        return t.slice(0, 2).toUpperCase();
      }

      function esc(s) {
        return String(s)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
      }

      var channelsById = {}

      function findChannelBlock(channelChatId) {
        return document.querySelector(
          '.channel-block[data-channel-id="' + String(channelChatId) + '"]'
        )
      }

      function renderChannelAdminsIntoPanel(ch, data, panelEl) {
        if (!panelEl) return
        if (!data || !Array.isArray(data.admins)) {
          panelEl.innerHTML =
            '<div class="admins-card"><div style="font-size:12px;color:var(--muted);padding:4px 0;">Не удалось загрузить список администраторов.</div></div>'
          return
        }
        var inviteRaw = data.invite_url ? String(data.invite_url) : ''
        var inviteTgRaw = data.invite_url_telegram ? String(data.invite_url_telegram) : ''
        var inviteAttr = inviteRaw ? esc(inviteRaw) : ''
        var inviteTgAttr = inviteTgRaw ? esc(inviteTgRaw) : ''
        var rows = (data.admins || [])
          .map(function (a) {
            var nm = esc(String(a.name || '—'))
            var tgOnly = a.admin_platform === 'telegram' && !a.max_user_id
            var peerBadge =
              a.peer_platform === 'telegram' || tgOnly
                ? '<span class="admin-peer-badge admin-peer-badge--tg" title="Telegram" aria-label="Telegram">✈</span>'
                : a.peer_platform === 'max'
                  ? '<span class="admin-peer-badge admin-peer-badge--max" title="MAX привязан" aria-label="MAX">M</span>'
                  : ''
            var ini = esc(String(a.initials || initials(a.name)))
            var connected = !!a.linked
            var cross = !!(a.paired || (a.max_user_id && a.tg_user_id))
            var statusCls = cross
              ? 'admin-status-connected'
              : connected
                ? 'admin-status-connected'
                : 'admin-status-pending'
            var dotCls = cross || connected ? 'admin-status-dot teal' : 'admin-status-dot yellow'
            var label = tgOnly
              ? connected
                ? 'Telegram · подключён'
                : 'Telegram · не в MAX'
              : cross
                ? 'MAX + Telegram'
                : connected
                  ? 'подключён'
                  : 'не подключён'
            var adminPlatform = tgOnly ? 'telegram' : 'max'
            var removeBtn =
              '<button type="button" class="btn-admin-disable" data-channel-id="' +
              esc(String(ch.chat_id)) +
              '" data-admin-user-id="' +
              esc(String(a.user_id)) +
              '" data-admin-platform="' +
              adminPlatform +
              '" data-admin-name="' +
              nm +
              '">Отключить</button>'
            return (
              '<div class="admin-row">' +
              '<div class="admin-av">' +
              ini +
              '</div>' +
              '<div class="admin-name">' +
              nm +
              peerBadge +
              '</div>' +
              '<div class="admin-row-controls"><div class="' +
              statusCls +
              '"><span class="' +
              dotCls +
              '" aria-hidden="true"></span>' +
              label +
              '</div>' +
              removeBtn +
              '</div></div>'
            )
          })
          .join('')
        var inviteBtnMax =
          inviteAttr !== ''
            ? '<button type="button" class="btn-invite">Ссылка для MAX</button>'
            : ''
        var inviteBtnTg =
          inviteTgAttr !== ''
            ? '<button type="button" class="btn-invite-tg">Ссылка для Telegram</button>'
            : ''
        var inviteHint =
          inviteTgAttr !== ''
            ? '<div style="font-size:11px;color:var(--muted);margin:8px 0 4px;">Админы только в Telegram — вторая ссылка.</div>'
            : ''
        var bodyRows =
          rows !== ''
            ? rows
            : '<div style="font-size:12px;color:var(--muted);padding:4px 0;">Нет администраторов в ответе API.</div>'
        panelEl.innerHTML =
          '<div class="admins-card" role="article"' +
          (inviteAttr !== '' ? ' data-invite-url="' + inviteAttr + '"' : '') +
          (inviteTgAttr !== '' ? ' data-invite-url-telegram="' + inviteTgAttr + '"' : '') +
          '>' +
          bodyRows +
          inviteHint +
          inviteBtnMax +
          inviteBtnTg +
          '</div>'
        panelEl.dataset.adminsLoaded = '1'
      }

      function loadChannelAdminsPanel(channelChatId, apiUid) {
        var block = findChannelBlock(channelChatId)
        if (!block || apiUid == null) return Promise.resolve()
        var panel = block.querySelector('.channel-admins-panel')
        if (!panel) return Promise.resolve()
        panel.innerHTML = '<div class="channel-admins-loading">Загрузка администраторов…</div>'
        return fetch(
          '/api/channel-admins?chat_id=' +
            encodeURIComponent(String(channelChatId)) +
            '&user_id=' +
            encodeURIComponent(String(apiUid)) +
            platformQs,
          { headers: homeApiHeaders(false) }
        )
          .then(function (r) {
            return r.ok ? r.json() : null
          })
          .then(function (admData) {
            var ch = channelsById[String(channelChatId)] || { chat_id: channelChatId, title: null }
            renderChannelAdminsIntoPanel(ch, admData, panel)
          })
      }

      function toggleChannelAdminsBlock(block, apiUid) {
        if (!block) return
        var willExpand = !block.classList.contains('expanded')
        block.classList.toggle('expanded', willExpand)
        var toggle = block.querySelector('.ch-admins-toggle')
        if (toggle) {
          toggle.setAttribute('aria-expanded', willExpand ? 'true' : 'false')
        }
        if (!willExpand) return
        var panel = block.querySelector('.channel-admins-panel')
        if (!panel || panel.dataset.adminsLoaded === '1') return
        var chatId = block.getAttribute('data-channel-id')
        if (!chatId) return
        loadChannelAdminsPanel(chatId, apiUid)
      }

      function refreshChannelAdminsCard(channelChatId, apiUid) {
        if (apiUid == null) return Promise.resolve()
        var ch = channelsById[String(channelChatId)] || { chat_id: channelChatId, title: null }
        return fetch(
          '/api/channel-admins?chat_id=' +
            encodeURIComponent(String(channelChatId)) +
            '&user_id=' +
            encodeURIComponent(String(apiUid)) +
            platformQs,
          { headers: homeApiHeaders(false) }
        )
          .then(function (r) {
            return r.ok ? r.json() : null
          })
          .then(function (admData) {
            var block = findChannelBlock(channelChatId)
            var panel = block && block.querySelector('.channel-admins-panel')
            if (!panel) return
            var ch = channelsById[String(channelChatId)] || { chat_id: channelChatId, title: null }
            renderChannelAdminsIntoPanel(ch, admData, panel)
          })
      }

      var displayName =
        [user.first_name, user.last_name].filter(Boolean).join(' ').trim() ||
        (user.username && String(user.username)) ||
        'Гость';
      document.getElementById('homeUserName').textContent = displayName;
      var uid = getBridgeNumericUserId(user);
      var uidFromQuery = mergedParams.get('user_id');
      if (uid == null && uidFromQuery) {
        var parsed = parseInt(uidFromQuery, 10);
        if (Number.isFinite(parsed) && parsed > 0) uid = parsed;
      }
      document.getElementById('homeUserId').textContent =
        uid != null
          ? 'ID: ' + uid + (inTelegram ? ' · Telegram' : '')
          : 'ID: — (откройте из MAX или Telegram)';

      var avEl = document.getElementById('homeUserAv');
      var homePhotoUrl = getBridgeUserPhotoUrl(user);
      if (homePhotoUrl) {
        avEl.innerHTML = '<img src="' + esc(homePhotoUrl) + '" alt="" />';
      } else {
        avEl.textContent = initials(displayName);
      }

      var testFb = document.getElementById('testUserFallback');
      var testIn = document.getElementById('testUserIdInput');
      var testBtn = document.getElementById('testUserIdApply');
      function wireTestUserApply() {
        if (!testBtn || testBtn.dataset.wired === '1') return;
        testBtn.dataset.wired = '1';
        testBtn.addEventListener('click', function () {
          var raw = testIn && testIn.value ? String(testIn.value).trim() : '';
          var parsed = parseInt(raw, 10);
          if (!Number.isFinite(parsed) || parsed <= 0) {
            setHomeErr('Введите положительное число — ваш ID из бота');
            return;
          }
          var sp = new URLSearchParams(location.search);
          sp.set('user_id', String(parsed));
          var q = sp.toString();
          location.search = q ? '?' + q : '';
        });
      }

      function syncSwitch(feature, enabled) {
        var sw = document.querySelector('[data-switch="' + feature + '"]');
        if (!sw) return;
        sw.classList.toggle('on', !!enabled);
        sw.setAttribute('aria-checked', enabled ? 'true' : 'false');
      }

      function wireFeatureToggles(apiUid) {
        document.querySelectorAll('.feat-cell').forEach(function (cell) {
          var feature = cell.getAttribute('data-feature');
          var disabled = cell.classList.contains('disabled');
          var sw = cell.querySelector('.switch');
          if (!feature || !sw) return;
          if (sw.dataset.featureWired === '1') return;
          sw.dataset.featureWired = '1';
          sw.addEventListener('click', function () {
            if (disabled || apiUid == null) {
              setHomeErr(
                apiUid == null
                  ? 'Откройте приложение из MAX или Telegram, чтобы сохранять настройки'
                  : 'Скоро'
              );
              return;
            }
            var next = !sw.classList.contains('on');
            sw.classList.toggle('on', next);
            sw.setAttribute('aria-checked', next ? 'true' : 'false');
            fetch('/api/settings' + (inTelegram ? '?platform=telegram' : ''), {
              method: 'POST',
              headers: homeApiHeaders(true),
              body: JSON.stringify({ user_id: apiUid, feature: feature, enabled: next }),
            })
              .then(function (r) {
                if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || String(r.status)); });
                return r.json();
              })
              .then(function (data) {
                syncSwitch('comments', data.comments);
                syncSwitch('notifications', data.notifications);
                syncSwitch('moderation', data.moderation);
                syncSwitch('auto_replies', data.auto_replies);
                setHomeErr('');
              })
              .catch(function (e) {
                setHomeErr(e, 'Не удалось сохранить настройку');
                sw.classList.toggle('on', !next);
                sw.setAttribute('aria-checked', !next ? 'true' : 'false');
              });
          });
        });
      }

      syncHomeUserBadge(uid);

      if (uid == null) {
        var inHostApp = inMax || inTelegram || isLikelyMaxMiniapp() || isLikelyTelegramWebView();
        if (inHostApp) {
          if (testFb) testFb.classList.remove('show');
          setHomeErr('');
          document.getElementById('homeUserName').textContent = 'Загрузка…';
          document.getElementById('homeUserId').textContent = 'ID: …';
          wireFeatureToggles(null);
          return;
        }
        if (testFb) testFb.classList.add('show');
        wireTestUserApply();
        setHomeErr('Откройте приложение из MAX или Telegram. Для проверки в браузере введите ID ниже.');
        wireFeatureToggles(null);
        return;
      }

      if (testFb) testFb.classList.remove('show');

      homeSettingsUid = uid;

      var settingsOverlayEl = document.getElementById('settingsOverlay');
      if (settingsOverlayEl && settingsOverlayEl.dataset.bound !== '1') {
        settingsOverlayEl.dataset.bound = '1';
        settingsOverlayEl.addEventListener('click', function (e) {
          if (e.target === settingsOverlayEl) closeChannelSettings();
        });
      }
      wireManagerUrlPasteButton();

      wireFeatureToggles(uid);

      ;(function bindAdminsActions() {
        var host = document.getElementById('homeChannelList')
        if (!host || host.dataset.actionsBound === '1') return
        host.dataset.actionsBound = '1'
        host.addEventListener('click', function (ev) {
          var toggleBtn = ev.target.closest('.ch-admins-toggle')
          if (toggleBtn) {
            var block = toggleBtn.closest('.channel-block')
            toggleChannelAdminsBlock(block, uid)
            return
          }
          var inviteBtn = ev.target.closest('.btn-invite, .btn-invite-tg')
          if (inviteBtn) {
            var cardForInvite = inviteBtn.closest('.admins-card')
            var url =
              inviteBtn.classList.contains('btn-invite-tg')
                ? cardForInvite && cardForInvite.getAttribute('data-invite-url-telegram')
                : cardForInvite && cardForInvite.getAttribute('data-invite-url')
            if (!url) return
            var p =
              navigator.clipboard && navigator.clipboard.writeText
                ? navigator.clipboard.writeText(url)
                : Promise.reject()
            p.catch(function () {
              try {
                var ta = document.createElement('textarea')
                ta.value = url
                ta.setAttribute('readonly', '')
                ta.style.position = 'fixed'
                ta.style.left = '-9999px'
                document.body.appendChild(ta)
                ta.select()
                document.execCommand('copy')
                document.body.removeChild(ta)
                return Promise.resolve()
              } catch (e) {
                return Promise.reject(e)
              }
            })
              .then(function () {
                showToast(
                  inviteBtn.classList.contains('btn-invite-tg')
                    ? 'Ссылка Telegram скопирована! Для админов без MAX'
                    : 'Ссылка MAX скопирована! Отправьте администраторам канала'
                )
              })
              .catch(function () {
                showToast('Не удалось скопировать ссылку')
              })
            return
          }

          var disableBtn = ev.target.closest('.btn-admin-disable')
          if (!disableBtn) return
          if (disableBtn.disabled) return
          var channelChatId = parseInt(disableBtn.getAttribute('data-channel-id') || '', 10)
          var targetUserId = parseInt(disableBtn.getAttribute('data-admin-user-id') || '', 10)
          var targetPlatform = disableBtn.getAttribute('data-admin-platform') || 'max'
          var targetName = String(disableBtn.getAttribute('data-admin-name') || '').trim()
          if (!Number.isFinite(channelChatId) || !Number.isFinite(targetUserId)) {
            showToast('Некорректные данные администратора')
            return
          }
          var actorUserId = uid
          if (!actorUserId) {
            showToast('Сначала откройте приложение из бота')
            return
          }
          var displayTarget = targetName || ('ID ' + targetUserId)
          if (
            !confirm(
              'Отключить администратора «' +
                displayTarget +
                '»?\n\nПользователь будет удалён из базы бота и потеряет админ-права в CommentBot.'
            )
          ) {
            return
          }
          disableBtn.disabled = true
          var prevText = disableBtn.textContent
          disableBtn.textContent = 'Отключение...'
          fetch('/api/channel-admins/disable' + (inTelegram ? '?platform=telegram' : ''), {
            method: 'POST',
            headers: homeApiHeaders(true),
            body: JSON.stringify({
              user_id: actorUserId,
              target_user_id: targetUserId,
              chat_id: inTelegram ? String(channelChatId) : channelChatId,
              ...(targetPlatform === 'telegram' ? { target_platform: 'telegram' } : {}),
            }),
          })
            .then(function (r) {
              return r.json().then(function (j) {
                return { ok: r.ok, body: j }
              })
            })
            .then(function (x) {
              if (!x.ok) {
                throw new Error((x.body && x.body.error) || 'Не удалось отключить администратора')
              }
              showToast('Администратор отключён')
              return refreshChannelAdminsCard(channelChatId, actorUserId)
            })
            .catch(function (e) {
              showToast(e, 'Не удалось отключить администратора')
            })
            .finally(function () {
              disableBtn.disabled = false
              disableBtn.textContent = prevText || 'Отключить'
            })
        })
      })()

      function patchChannelRowLive(ch) {
        if (!ch || ch.chat_id == null) return
        var key = String(ch.chat_id)
        channelsById[key] = Object.assign({}, channelsById[key] || { chat_id: ch.chat_id }, ch)
        var block = findChannelBlock(ch.chat_id)
        if (!block) return
        var subsEl = block.querySelector('.ch-subs')
        if (subsEl && typeof ch.subscribers === 'number') {
          subsEl.textContent = 'подписчики: ' + ch.subscribers
        }
        var avUrl =
          ch.avatar_url && String(ch.avatar_url).trim() ? String(ch.avatar_url).trim() : ''
        if (!avUrl) return
        var icon = block.querySelector('.ch-icon')
        if (!icon) return
        icon.classList.add('with-photo')
        icon.innerHTML = '<img src="' + esc(avUrl) + '" alt="" />'
      }

      function enrichChannelsLive(apiUid) {
        if (apiUid == null) return
        fetch(
          '/api/channels?user_id=' +
            encodeURIComponent(String(apiUid)) +
            platformQs +
            '&live=1',
          { headers: homeApiHeaders(false) }
        )
          .then(function (r) {
            return r.ok ? r.json() : null
          })
          .then(function (data) {
            if (!data || !Array.isArray(data.channels)) return
            data.channels.forEach(patchChannelRowLive)
          })
          .catch(function () {})
      }

      fetch('/api/settings?user_id=' + encodeURIComponent(String(uid)) + platformQs, {
        headers: homeApiHeaders(false),
      })
        .then(function (r) {
          if (!r.ok) throw new Error('settings');
          return r.json();
        })
        .then(function (data) {
          syncSwitch('comments', data.comments);
          syncSwitch('notifications', data.notifications);
          syncSwitch('moderation', data.moderation);
          syncSwitch('auto_replies', data.auto_replies);
        })
        .catch(function () {});

      fetch('/api/stats?user_id=' + encodeURIComponent(String(uid)) + platformQs, {
        headers: homeApiHeaders(false),
      })
        .then(function (r) {
          if (!r.ok) throw new Error('stats');
          return r.json();
        })
        .then(function (s) {
          document.getElementById('statCh').textContent = String(s.channels ?? 0);
          document.getElementById('statPosts').textContent = String(s.posts ?? 0);
          document.getElementById('statComm').textContent = String(s.comments ?? 0);
          if (s.bot_nickname) botNick = '@' + String(s.bot_nickname).replace(/^@/, '');
        })
        .catch(function () {
          setHomeErr('Не удалось загрузить статистику');
        });

      fetch('/api/channels?user_id=' + encodeURIComponent(String(uid)) + platformQs, {
        headers: homeApiHeaders(false),
      })
        .then(function (r) {
          if (!r.ok) throw new Error('ch');
          return r.json();
        })
        .then(function (data) {
          var list = document.getElementById('homeChannelList');
          list.innerHTML = '';
          channelsById = {}
          channelsCache = []
          if (data.bot_nickname) botNick = '@' + String(data.bot_nickname).replace(/^@/, '');
          var arr = data.channels || [];
          if (!arr.length) {
            list.innerHTML =
              '<div style="color:var(--muted);font-size:13px;padding:8px 4px;">' +
              (inTelegram
                ? 'Каналов пока нет. Добавьте @commentvmax_bot администратором в Telegram-канал, затем обновите мини-приложение.'
                : 'Каналов пока нет. Подключите бота в свой канал.') +
              '</div>';
            return;
          }
          arr.forEach(function (ch) {
            channelsById[String(ch.chat_id)] = ch
            channelsCache.push(ch)
            var title = (ch.title && String(ch.title).trim()) || 'Канал ' + ch.chat_id;
            var subs =
              typeof ch.subscribers === 'number'
                ? 'подписчики: ' + ch.subscribers
                : 'подписчики: —';
            var dotClass = ch.status === 'pending' ? 'pending' : 'active';
            var avUrl =
              ch.avatar_url && String(ch.avatar_url).trim()
                ? String(ch.avatar_url).trim()
                : '';
            var iconHtml = avUrl
              ? '<div class="ch-icon with-photo"><img src="' +
                esc(avUrl) +
                '" alt="" /></div>'
              : '<div class="ch-icon">' + esc(initials(title)) + '</div>';
            var gearBtn = inTelegram
              ? ''
              : '<button type="button" class="ch-gear-btn" ' +
                'onclick="openChannelSettings(' +
                JSON.stringify(ch.chat_id) +
                ')" ' +
                'aria-label="Настройки канала">⚙️</button>';
            var row =
              '<div class="channel-block" data-channel-id="' +
              esc(String(ch.chat_id)) +
              '">' +
              '<div class="channel-item">' +
              iconHtml +
              '<div class="ch-body"><div class="ch-name">' +
              esc(title) +
              '</div><div class="ch-subs">' +
              esc(subs) +
              '</div></div>' +
              '<span class="status-dot ' +
              dotClass +
              '" title="' +
              (ch.status === 'pending' ? 'Ожидает прав' : 'Активен') +
              '"></span>' +
              '<button type="button" class="ch-admins-toggle" aria-expanded="false" aria-label="Администраторы канала">▼</button>' +
              gearBtn +
              '</div>' +
              '<div class="channel-admins-panel" data-admins-loaded="0"></div>' +
              '</div>';
            list.insertAdjacentHTML('beforeend', row);
          });
          enrichChannelsLive(uid);
          if (pendingOpenChannelLink && inTelegram) {
            fillLinkChannelSelect(
              document.getElementById('linkTgChannelSelect'),
              channelsCache,
              'TG'
            );
            showChannelLinkOverlay('tg');
          }
        })
        .catch(function () {});

      var hint = document.getElementById('connectHint');
      document.getElementById('btnConnect').addEventListener('click', function () {
        hint.textContent = inTelegram
          ? 'Добавьте @commentvmax_bot в Telegram-канал как администратора, затем перезайдите в мини-приложение.'
          : 'Добавь бота ' + botNick + ' в канал как администратора.';
        hint.classList.toggle('show', !hint.classList.contains('show'));
      });

      var panel = document.getElementById('channelSettingsPanel');
      document.getElementById('btnChannelSettings').addEventListener('click', function () {
        var open = !panel.classList.contains('open');
        panel.classList.toggle('open', open);
        if (!open) return;
        fetch('/api/channels?user_id=' + encodeURIComponent(String(uid)) + platformQs, {
          headers: homeApiHeaders(false),
        })
          .then(function (r) {
            return r.json();
          })
          .then(function (data) {
            var arr = data.channels || [];
            if (!arr.length) {
              panel.textContent = inTelegram
                ? 'Сначала добавьте @commentvmax_bot администратором в Telegram-канал.'
                : 'Сначала подключите бота к каналу. Затем здесь появятся настройки для каждого канала.';
              return;
            }
            panel.innerHTML =
              '<strong style="color:var(--text)">Каналы</strong><ul style="margin:8px 0 0;padding-left:18px;">' +
              arr
                .map(function (ch) {
                  var t = (ch.title && String(ch.title).trim()) || 'ID ' + ch.chat_id;
                  return '<li style="margin-bottom:6px;">' + esc(t) + ' — скоро: расширенные настройки.</li>';
                })
                .join('') +
              '</ul>';
          })
          .catch(function () {
            panel.textContent = 'Не удалось загрузить список каналов.';
          });
      });

      var pendingOpenChannelLink = false
      var linkDecode = decodeStartParam(startParam)
      if (linkDecode && linkDecode.open_channel_link) {
        pendingOpenChannelLink = true
      }

      function ownerProfilePayload(apiUid) {
        return {
          user_id: apiUid,
          username: user.username || null,
          first_name: user.first_name || null,
          last_name: user.last_name || null,
          photo_url: getBridgeUserPhotoUrl(user),
        }
      }

      function reloadHomeAdmins(apiUid) {
        if (apiUid == null || !channelsCache.length) return
        channelsCache.forEach(function (ch) {
          var block = findChannelBlock(ch.chat_id)
          if (!block) return
          var panel = block.querySelector('.channel-admins-panel')
          if (!panel) return
          if (block.classList.contains('expanded')) {
            panel.dataset.adminsLoaded = '0'
            loadChannelAdminsPanel(ch.chat_id, apiUid)
          } else {
            panel.dataset.adminsLoaded = '0'
            panel.innerHTML = ''
          }
        })
      }

      function loadChannelLinks(apiUid) {
        var host = document.getElementById('homeChannelLinksList')
        if (!host || apiUid == null) return
        fetch('/api/channel-links?user_id=' + encodeURIComponent(String(apiUid)) + platformQs, {
          headers: homeApiHeaders(false),
        })
          .then(function (r) {
            return r.ok ? r.json() : { links: [] }
          })
          .then(function (data) {
            var links = data.links || []
            window.__channelLinksCache = links
            host.innerHTML = ''
            if (!links.length) {
              host.innerHTML =
                '<div style="color:var(--muted);font-size:13px;padding:8px 4px;">' +
                (inTelegram
                  ? 'Связок пока нет. Получите код в MAX → здесь введите его и подтвердите в боте MAX.'
                  : 'Связок пока нет. Создайте код и завершите привязку в Telegram.') +
                '</div>'
              return
            }
            links.forEach(function (lnk) {
              var tgT = esc(String(lnk.tg_title || lnk.tg_username || 'Telegram'))
              var mxT = esc(String(lnk.max_title || 'MAX ' + lnk.max_chat_id))
              var st = lnk.active ? 'active' : 'pending'
              var meta =
                (lnk.forward_posts ? 'посты' : '') +
                (lnk.add_comments_button !== false ? ' · 💬' : '') +
                ' · сегодня ' +
                String(lnk.forwarded_today || 0)
              host.insertAdjacentHTML(
                'beforeend',
                '<div class="channel-link-item">' +
                  '<div class="channel-link-flow">' +
                  tgT +
                  '<div class="channel-link-sub">→ ' +
                  mxT +
                  '</div><div class="channel-link-sub">' +
                  esc(meta) +
                  '</div></div>' +
                  '<span class="status-dot ' +
                  st +
                  '" title="' +
                  (lnk.active ? 'Активна' : 'Пауза') +
                  '"></span></div>'
              )
            })
          })
          .catch(function () {})
      }

      function setLinkWizardProgress(step) {
        var wrap = document.getElementById('linkWizardSteps')
        var d1 = document.getElementById('linkWizardDot1')
        var d2 = document.getElementById('linkWizardDot2')
        var d3 = document.getElementById('linkWizardDot3')
        if (!wrap || !d1 || !d2 || !d3) return
        if (inTelegram) {
          wrap.classList.add('hidden')
          wrap.setAttribute('aria-hidden', 'true')
          return
        }
        wrap.classList.remove('hidden')
        wrap.setAttribute('aria-hidden', 'false')
        d1.classList.toggle('on', step >= 1)
        d2.classList.toggle('on', step >= 2)
        d3.classList.toggle('on', step >= 3)
      }

      function hideAllChannelLinkPanes() {
        ;['channelLinkStepMax', 'channelLinkStepCode', 'channelLinkStepTg', 'channelLinkStepTgDone'].forEach(
          function (id) {
            var el = document.getElementById(id)
            if (el) el.classList.add('hidden')
          }
        )
      }

      function showChannelLinkOverlay(mode, subStep) {
        var ov = document.getElementById('channelLinkOverlay')
        var stepMax = document.getElementById('channelLinkStepMax')
        var stepCode = document.getElementById('channelLinkStepCode')
        var stepTg = document.getElementById('channelLinkStepTg')
        var stepTgDone = document.getElementById('channelLinkStepTgDone')
        var title = document.getElementById('channelLinkOverlayTitle')
        var desc = document.getElementById('channelLinkOverlayDesc')
        if (!ov || !stepMax || !stepCode || !stepTg) return
        hideAllChannelLinkPanes()
        if (mode === 'max') {
          title.textContent = 'Связка с Telegram'
          if (subStep === 'code') {
            desc.textContent = 'Скопируйте код и завершите шаги в Telegram, затем подтвердите в боте MAX.'
            stepCode.classList.remove('hidden')
            setLinkWizardProgress(2)
          } else {
            desc.textContent = 'Сначала MAX: выберите канал и получите код.'
            stepMax.classList.remove('hidden')
            setLinkWizardProgress(1)
          }
        } else if (subStep === 'done') {
          title.textContent = 'Почти готово'
          desc.textContent = 'Остался последний шаг в MAX.'
          if (stepTgDone) stepTgDone.classList.remove('hidden')
        } else {
          title.textContent = 'Связка с MAX'
          desc.textContent = 'Введите код из MAX и выберите активный Telegram-канал.'
          stepTg.classList.remove('hidden')
        }
        ov.classList.remove('hidden')
        ov.setAttribute('aria-hidden', 'false')
      }

      function hideChannelLinkOverlay() {
        var ov = document.getElementById('channelLinkOverlay')
        if (!ov) return
        ov.classList.add('hidden')
        ov.setAttribute('aria-hidden', 'true')
        hideAllChannelLinkPanes()
        var codeIn = document.getElementById('linkCodeInput')
        if (codeIn) codeIn.value = ''
        window.__linkDraftCode = ''
      }

      function linkableChannelsForWizard(arr) {
        return (arr || []).filter(function (ch) {
          return ch.status !== 'pending'
        })
      }

      function fillLinkChannelSelect(selectEl, arr, platformLabel, options) {
        if (!selectEl) return []
        var list = options && options.allowPending ? arr || [] : linkableChannelsForWizard(arr)
        var hint = document.getElementById('linkTgNoChannelsHint')
        selectEl.innerHTML = ''
        if (!list.length) {
          var opt = document.createElement('option')
          opt.value = ''
          opt.textContent = 'Нет готовых каналов'
          selectEl.appendChild(opt)
          if (hint && inTelegram) {
            hint.textContent =
              'Нет каналов с правами бота. Добавьте @commentvmax_bot администратором в Telegram-канал и обновите список.'
            hint.classList.remove('hidden')
          }
          var confirmBtnEmpty = document.getElementById('linkTgConfirmBtn')
          if (confirmBtnEmpty && inTelegram) confirmBtnEmpty.disabled = true
          return list
        }
        if (hint) hint.classList.add('hidden')
        var confirmBtn = document.getElementById('linkTgConfirmBtn')
        if (confirmBtn && inTelegram) confirmBtn.disabled = false
        list.forEach(function (ch) {
          var opt = document.createElement('option')
          opt.value = String(ch.chat_id)
          var t = (ch.title && String(ch.title).trim()) || platformLabel + ' ' + ch.chat_id
          opt.textContent = t
          selectEl.appendChild(opt)
        })
        return list
      }

      function renderAccountPairingRow(status) {
        var row = document.getElementById('accountPairRow')
        if (!row) return
        row.innerHTML = ''
        if (!status) return
        if (inTelegram) {
          if (status.max_linked) {
            var mxName = status.max_account && status.max_account.name ? status.max_account.name : 'MAX'
            row.innerHTML =
              '<span class="account-pair-status"><span aria-hidden="true">✓</span> MAX привязан · ' +
              esc(mxName) +
              '</span>'
            return
          }
          var btnMax = document.createElement('button')
          btnMax.type = 'button'
          btnMax.className = 'btn-pair-peer btn-pair-peer--max'
          btnMax.id = 'btnPairMaxAccount'
          btnMax.textContent = 'Связать MAX'
          row.appendChild(btnMax)
          return
        }
        if (status.telegram_linked) {
          var tgName =
            status.telegram_account && status.telegram_account.name
              ? status.telegram_account.name
              : 'Telegram'
          row.innerHTML =
            '<span class="account-pair-status"><span aria-hidden="true">✓</span> Telegram привязан · ' +
            esc(tgName) +
            '</span>'
          return
        }
        var btnTg = document.createElement('button')
        btnTg.type = 'button'
        btnTg.className = 'btn-pair-peer btn-pair-peer--tg'
        btnTg.id = 'btnPairTelegramAccount'
        btnTg.innerHTML = '<span aria-hidden="true">✈</span> Связать Telegram'
        row.appendChild(btnTg)
      }

      function loadAccountPairingStatus(apiUid) {
        if (apiUid == null) return
        fetch(
          '/api/account-pairing/status?user_id=' + encodeURIComponent(String(apiUid)) + platformQs,
          { headers: homeApiHeaders(false) }
        )
          .then(function (r) {
            return r.ok ? r.json() : null
          })
          .then(function (st) {
            renderAccountPairingRow(st)
            wireAccountPairingButtons(apiUid, st)
          })
          .catch(function () {})
      }

      function openExternalInviteUrl(url) {
        if (!url) return
        try {
          if (inTelegram && bridge.openLink) {
            bridge.openLink(url)
            return
          }
          if (!inTelegram && bridge.openMaxLink) {
            bridge.openMaxLink(url)
            return
          }
        } catch (e) {}
        window.open(url, '_blank', 'noopener,noreferrer')
      }

      function wireAccountPairingButtons(apiUid, status) {
        if (apiUid == null || !status) return
        var btnTg = document.getElementById('btnPairTelegramAccount')
        var btnMax = document.getElementById('btnPairMaxAccount')
        if (btnTg && btnTg.dataset.bound !== '1') {
          btnTg.dataset.bound = '1'
          btnTg.addEventListener('click', function () {
            btnTg.disabled = true
            fetch('/api/account-pairing/invite-telegram', {
              method: 'POST',
              headers: homeApiHeaders(true),
              body: JSON.stringify(ownerProfilePayload(apiUid)),
            })
              .then(function (r) {
                return r.json().then(function (j) {
                  return { ok: r.ok, body: j }
                })
              })
              .then(function (x) {
                if (!x.ok) throw new Error((x.body && x.body.error) || 'Ошибка')
                openExternalInviteUrl(x.body.invite_url)
                showToast('Откройте Telegram и нажмите Start в боте')
              })
              .catch(function (e) {
                showToast(e, 'Не удалось создать ссылку')
              })
              .finally(function () {
                btnTg.disabled = false
              })
          })
        }
        if (btnMax && btnMax.dataset.bound !== '1') {
          btnMax.dataset.bound = '1'
          btnMax.addEventListener('click', function () {
            btnMax.disabled = true
            fetch('/api/account-pairing/invite-max', {
              method: 'POST',
              headers: homeApiHeaders(true),
              body: JSON.stringify(ownerProfilePayload(apiUid)),
            })
              .then(function (r) {
                return r.json().then(function (j) {
                  return { ok: r.ok, body: j }
                })
              })
              .then(function (x) {
                if (!x.ok) throw new Error((x.body && x.body.error) || 'Ошибка')
                openExternalInviteUrl(x.body.invite_url)
                showToast('Откройте MAX и запустите бота по ссылке')
              })
              .catch(function (e) {
                showToast(e, 'Не удалось создать ссылку')
              })
              .finally(function () {
                btnMax.disabled = false
              })
          })
        }
      }

      if (uid != null) {
        window.setTimeout(function () {
          fetch('/api/owner-profile/sync', {
            method: 'POST',
            headers: homeApiHeaders(true),
            body: JSON.stringify(ownerProfilePayload(uid)),
          }).catch(function () {})
          loadAccountPairingStatus(uid)
          loadChannelLinks(uid)
        }, 0)
      }

      var btnCreateLink = document.getElementById('btnCreateChannelLink')
      if (btnCreateLink && btnCreateLink.dataset.bound !== '1') {
        btnCreateLink.dataset.bound = '1'
        btnCreateLink.addEventListener('click', function () {
          if (uid == null) {
            showToast('Не удалось определить ваш профиль')
            return
          }
          if (inTelegram) {
            fillLinkChannelSelect(
              document.getElementById('linkTgChannelSelect'),
              channelsCache,
              'TG'
            )
            var codeIn = document.getElementById('linkCodeInput')
            if (codeIn) codeIn.value = ''
            var prev = document.getElementById('linkTgPreview')
            if (prev) prev.textContent = ''
            showChannelLinkOverlay('tg')
            return
          }
          fillLinkChannelSelect(
            document.getElementById('linkMaxChannelSelect'),
            channelsCache,
            'MAX'
          )
          showChannelLinkOverlay('max', 'pick')
        })
      }

      var linkMaxBtn = document.getElementById('linkMaxGenerateBtn')
      if (linkMaxBtn && linkMaxBtn.dataset.bound !== '1') {
        linkMaxBtn.dataset.bound = '1'
        linkMaxBtn.addEventListener('click', function () {
          if (uid == null) return
          var sel = document.getElementById('linkMaxChannelSelect')
          var maxId = sel ? parseInt(sel.value, 10) : NaN
          if (!Number.isFinite(maxId) || maxId === 0) {
            showToast('Выберите канал MAX')
            return
          }
          linkMaxBtn.disabled = true
          fetch('/api/channel-link-drafts', {
            method: 'POST',
            headers: homeApiHeaders(true),
            body: JSON.stringify(
              Object.assign({ max_chat_id: maxId }, ownerProfilePayload(uid))
            ),
          })
            .then(function (r) {
              return r.json().then(function (j) {
                return { ok: r.ok, body: j }
              })
            })
            .then(function (x) {
              if (!x.ok) throw new Error((x.body && x.body.error) || 'Ошибка')
              var codeEl = document.getElementById('linkCodeValue')
              if (codeEl) codeEl.textContent = String(x.body.code || '')
              var hint = document.getElementById('linkCodeHint')
              if (hint) {
                hint.textContent =
                  'Для «' +
                  (x.body.max_title || 'MAX') +
                  '». Действует 15 минут.'
              }
              window.__linkDraftCode = String(x.body.code || '')
              showChannelLinkOverlay('max', 'code')
            })
            .catch(function (e) {
              showToast(e, 'Не удалось создать код')
            })
            .finally(function () {
              linkMaxBtn.disabled = false
            })
        })
      }

      var linkCopyBtn = document.getElementById('linkCodeCopyBtn')
      if (linkCopyBtn && linkCopyBtn.dataset.bound !== '1') {
        linkCopyBtn.dataset.bound = '1'
        linkCopyBtn.addEventListener('click', function () {
          var code = window.__linkDraftCode || ''
          if (!code) return
          try {
            navigator.clipboard.writeText(code)
            showToast('Код скопирован')
          } catch (e) {
            showToast(code)
          }
        })
      }

      var linkTgBtn = document.getElementById('linkTgConfirmBtn')
      if (linkTgBtn && linkTgBtn.dataset.bound !== '1') {
        linkTgBtn.dataset.bound = '1'
        linkTgBtn.addEventListener('click', function () {
          if (uid == null) return
          var sel = document.getElementById('linkTgChannelSelect')
          var tgId = sel ? String(sel.value).trim() : ''
          var code = document.getElementById('linkCodeInput')
          var codeVal = code ? String(code.value || '').trim().toUpperCase() : ''
          if (!tgId) {
            showToast('Выберите Telegram-канал (бот должен быть админом)')
            return
          }
          if (!/^[A-Z0-9]{6}$/.test(codeVal)) {
            showToast('Введите 6-символьный код из MAX')
            return
          }
          var picked = channelsCache.find(function (c) {
            return String(c.chat_id) === tgId
          })
          if (picked && picked.status === 'pending') {
            showToast('Сначала выдайте боту права администратора в канале')
            return
          }
          linkTgBtn.disabled = true
          fetch(
            '/api/channel-link-drafts/' + encodeURIComponent(codeVal) + '/confirm',
            {
              method: 'POST',
              headers: homeApiHeaders(true),
              body: JSON.stringify(
                Object.assign(
                  { tg_channel_id: tgId },
                  ownerProfilePayload(uid)
                )
              ),
            }
          )
            .then(function (r) {
              return r.json().then(function (j) {
                return { ok: r.ok, body: j }
              })
            })
            .then(function (x) {
              if (!x.ok) throw new Error((x.body && x.body.error) || 'Ошибка')
              showToast('Код принят — подтвердите в боте MAX')
              showChannelLinkOverlay('tg', 'done')
              if (uid != null) {
                setTimeout(function () {
                  loadChannelLinks(uid)
                }, 1500)
              }
            })
            .catch(function (e) {
              showToast(e, 'Не удалось связать каналы')
            })
            .finally(function () {
              linkTgBtn.disabled = false
            })
        })
      }

      var linkCodeInput = document.getElementById('linkCodeInput')
      if (linkCodeInput && linkCodeInput.dataset.bound !== '1') {
        linkCodeInput.dataset.bound = '1'
        linkCodeInput.addEventListener('input', function () {
          var v = String(linkCodeInput.value || '')
            .toUpperCase()
            .replace(/[^A-Z0-9]/g, '')
            .slice(0, 6)
          linkCodeInput.value = v
          var preview = document.getElementById('linkTgPreview')
          if (!preview || v.length !== 6) {
            if (preview) preview.textContent = ''
            return
          }
          fetch('/api/channel-link-drafts/' + encodeURIComponent(v), {
            headers: homeApiHeaders(false),
          })
            .then(function (r) {
              return r.ok ? r.json() : null
            })
            .then(function (data) {
              if (!preview || !data) {
                if (preview) preview.textContent = ''
                return
              }
              if (data.status === 'pending') {
                preview.textContent = '✓ MAX: «' + (data.max_title || 'канал') + '»'
              } else if (data.status === 'awaiting_max_confirm') {
                preview.textContent = 'Код уже использован — ждёт кнопку в боте MAX'
              } else if (data.status === 'completed') {
                preview.textContent = 'Связка уже создана'
              } else if (data.status === 'expired') {
                preview.textContent = 'Код истёк — создайте новый в MAX'
              } else {
                preview.textContent = 'Код недоступен'
              }
            })
            .catch(function () {})
        })
      }

      var linkOvClose = document.getElementById('channelLinkOverlayClose')
      var linkOv = document.getElementById('channelLinkOverlay')
      if (linkOvClose && linkOvClose.dataset.bound !== '1') {
        linkOvClose.dataset.bound = '1'
        linkOvClose.addEventListener('click', hideChannelLinkOverlay)
      }
      if (linkOv && linkOv.dataset.bound !== '1') {
        linkOv.dataset.bound = '1'
        linkOv.addEventListener('click', function (e) {
          if (e.target === linkOv) hideChannelLinkOverlay()
        })
      }

      var overlay = document.getElementById('instructionOverlay');
      document.getElementById('btnInstruction').addEventListener('click', function () {
        overlay.classList.remove('hidden');
        overlay.setAttribute('aria-hidden', 'false');
      });
      document.getElementById('instructionClose').addEventListener('click', function () {
        overlay.classList.add('hidden');
        overlay.setAttribute('aria-hidden', 'true');
      });
      overlay.addEventListener('click', function (e) {
        if (e.target === overlay) {
          overlay.classList.add('hidden');
          overlay.setAttribute('aria-hidden', 'true');
        }
      });
    }

    function showGate() {
      if (viewGate) viewGate.classList.remove('hidden');
      viewComments.classList.add('hidden');

      var gateChannelEl = document.getElementById('gateChannelName');
      var gateHintEl = document.getElementById('gateLaunchHint');
      var gateBtnEl = document.getElementById('gateLaunchBtn');
      if (inTelegram && gateHintEl) {
        gateHintEl.textContent =
          'Откроется @commentvmax_bot в Telegram. Нажмите «Запустить» или напишите любое сообщение боту.';
      }

      if (chatId && gateChannelEl) {
        var channelInfoQs = inTelegram ? '?platform=telegram&' : '?';
        fetch(
          '/api/channel-info' +
            channelInfoQs +
            'chat_id=' +
            encodeURIComponent(inTelegram ? String(chatId) : chatId)
        )
          .then(function (r) {
            return r.json();
          })
          .then(function (data) {
            gateChannelEl.textContent = data.title ? '«' + data.title + '»' : '';
          })
          .catch(function () {});
      }

      fetch('/api/config')
        .then(function (r) {
          return r.json();
        })
        .then(function (cfg) {
          var nick = String(
            (inTelegram && cfg.telegram_bot_username) || cfg.bot_nickname || 'commentvmax_bot'
          ).replace(/^@/, '');
          var url = inTelegram ? 'https://t.me/' + nick : 'https://max.ru/' + nick;
          if (gateBtnEl) {
            gateBtnEl.href = url;
            gateBtnEl.textContent = inTelegram ? '💬 Открыть бота в Telegram' : '💬 Написать боту';
          }
        })
        .catch(function () {
          if (gateBtnEl) {
            gateBtnEl.href = inTelegram ? 'https://t.me/commentvmax_bot' : 'https://max.ru/bot';
          }
        });
    }

    function bootComments() {
      if (!hasPostContext || joinChannelId) return;

      if (window.visualViewport) {
        var shellEl = document.querySelector('.shell')
        var commentsViewEl = document.getElementById('view-comments')
        var rootEl = document.documentElement
        var MIN_KEYBOARD_HEIGHT = 120
        var keyboardFocused = false
        var isTextField = function (el) {
          if (!el || !el.tagName) return false
          var tag = String(el.tagName).toLowerCase()
          return tag === 'input' || tag === 'textarea'
        }
        var syncViewportLayout = function () {
          var vv = window.visualViewport
          if (!vv) return
          if (shellEl) {
            shellEl.style.top = vv.offsetTop + 'px'
            shellEl.style.bottom = 'auto'
            shellEl.style.height = vv.height + 'px'
          }
          var layoutHeight = Math.max(window.innerHeight || 0, document.documentElement.clientHeight || 0)
          var keyboardInset = layoutHeight - (vv.height + vv.offsetTop)
          var keyboardOpen = keyboardFocused || keyboardInset > MIN_KEYBOARD_HEIGHT
          rootEl.style.setProperty(
            '--composer-safe-bottom',
            keyboardOpen ? '0px' : 'env(safe-area-inset-bottom)'
          )
        }
        if (commentsViewEl && commentsViewEl.dataset.keyboardBound !== '1') {
          commentsViewEl.dataset.keyboardBound = '1'
          commentsViewEl.addEventListener('focusin', function (e) {
            if (!isTextField(e.target)) return
            keyboardFocused = true
            rootEl.style.setProperty('--composer-safe-bottom', '0px')
            syncViewportLayout()
          })
          commentsViewEl.addEventListener('focusout', function (e) {
            if (!isTextField(e.target)) return
            keyboardFocused = false
            window.setTimeout(syncViewportLayout, 80)
          })
        }
        window.visualViewport.addEventListener('resize', syncViewportLayout)
        window.visualViewport.addEventListener('scroll', syncViewportLayout)
        syncViewportLayout()
      }

      var uid =
        getBridgeNumericUserId(user) ||
        parseInt(mergedParams.get('user_id') || '', 10) ||
        null;

      if (!uid) {
        showGate();
        return;
      }

      function shouldSkipSubscribeGate() {
        if (adminParam) return true;
        if (inTelegram) {
          var tgUid = String(mergedParams.get('tg_uid') || '').trim();
          var tgSig = String(mergedParams.get('tg_sig') || '').trim();
          if (/^\d+$/.test(tgUid) && /^[a-f0-9]{64}$/i.test(tgSig)) return true;
        }
        return false;
      }

      function openCommentsAfterStatusCheck() {
        loadPostAndComments();
      }

      if (shouldSkipSubscribeGate()) {
        openCommentsAfterStatusCheck();
        return;
      }

      var statusQs =
        '?user_id=' +
        encodeURIComponent(String(uid)) +
        (inTelegram ? '&platform=telegram' : '') +
        (chatId ? '&chat_id=' + encodeURIComponent(chatId) : '');
      if (inTelegram) {
        var tgUidQ = mergedParams.get('tg_uid');
        var tgExpQ = mergedParams.get('tg_exp');
        var tgSigQ = mergedParams.get('tg_sig');
        if (tgUidQ) statusQs += '&tg_uid=' + encodeURIComponent(String(tgUidQ));
        if (tgExpQ) statusQs += '&tg_exp=' + encodeURIComponent(String(tgExpQ));
        if (tgSigQ) statusQs += '&tg_sig=' + encodeURIComponent(String(tgSigQ));
        if (adminParam) statusQs += '&admin=1';
      }

      var statusHeaders = inTelegram ? { 'X-Miniapp-Platform': 'telegram' } : {};
      fetch('/api/user-status' + statusQs, { headers: statusHeaders })
        .then(function (r) {
          return r.json();
        })
        .then(function (data) {
          if (data && data.is_admin) {
            mergedParams.set('admin', '1');
          }
          if (data && (data.started || data.is_admin)) {
            openCommentsAfterStatusCheck();
          } else {
            showGate();
          }
        })
        .catch(function () {
          openCommentsAfterStatusCheck();
        });
    }

    function loadPostAndComments() {
      viewComments.classList.remove('hidden');
      if (viewGate) viewGate.classList.add('hidden');

      var chatIdForReg = mergedParams.get('chat_id');
      var uid =
        getBridgeNumericUserId(user) ||
        parseInt(mergedParams.get('user_id') || '', 10) ||
        null;
      if (uid && chatIdForReg) {
        fetch('/api/register-subscriber', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            user_id: uid,
            chat_id: Number(chatIdForReg),
            source: 'miniapp_open',
          }),
        }).catch(function () {});
      }

      var params = mergedParams;
      var postId = params.get('post_id');
      var chatId = params.get('chat_id');
      var userIdRaw = params.get('user_id');
      var userId =
        userIdRaw && String(userIdRaw).trim() ? String(userIdRaw).trim() : '';
      if (!userId) {
        var bidComments = getBridgeNumericUserId(user);
        if (bidComments != null) userId = String(bidComments);
      }
      var username = params.get('username');
      if (!username || !String(username).trim()) {
        username =
          [user.first_name, user.last_name].filter(Boolean).join(' ').trim() ||
          (user.username && String(user.username).trim()) ||
          'Гость';
      }
      var adminNameForReply =
        [user.first_name, user.last_name]
          .filter(Boolean)
          .map(function (s) {
            return String(s).trim();
          })
          .filter(Boolean)
          .join(' ') ||
        (user.username && String(user.username).trim()) ||
        (username && String(username).trim()) ||
        'Админ';
      var isAdmin = isAdminParamValue(params.get('admin'));
      function promoteAdminMode() {
        if (isAdmin) return false;
        isAdmin = true;
        params.set('admin', '1');
        mergedParams.set('admin', '1');
        return true;
      }

      var chAvatarEl = document.getElementById('chAvatar');
      var chNameEl = document.getElementById('chName');
      var countBadgeEl = document.getElementById('countBadge');
      var postPreviewTextEl = document.getElementById('postPreviewText');
      var postPreviewActionEl = document.getElementById('postPreviewAction');
      var postThumbEl = document.getElementById('postThumb');
      var postPreviewBtnEl = document.getElementById('postPreviewBtn');
      var postDetailOverlayEl = document.getElementById('postDetailOverlay');
      var postDetailTitleEl = document.getElementById('postDetailTitle');
      var postDetailTextEl = document.getElementById('postDetailText');
      var postDetailImgEl = document.getElementById('postDetailImg');
      var postDetailCloseEl = document.getElementById('postDetailClose');
      var postDetailOpenChannelEl = document.getElementById('postDetailOpenChannel');
      var currentPostSnapshot = null;
      var postPreviewReady = false;
      var replyBannerEl = document.getElementById('replyBanner');
      var replyBannerNameEl = document.getElementById('replyBannerName');
      var replyBannerCloseEl = document.getElementById('replyBannerClose');
      var feedEl = document.getElementById('feed');
      var errEl = document.getElementById('err');
      var composerWrapEl = document.querySelector('#view-comments .composer-wrap');
      var inputEl = document.getElementById('input');
      var sendBtn = document.getElementById('sendBtn');
      var photoBtnEl = document.getElementById('photoBtn');
      var photoInputEl = document.getElementById('photoInput');
      var composerAttachmentsEl = document.getElementById('composerAttachments');
      var currentPostId = postId;
      var COMPOSER_INPUT_MAX_HEIGHT = 120;

      var knownIds = new Set();
      var postCommentCount = null;
      var channelPostUrl = null;
      var replyContext = null; // { comment_id, username, post_id }
      var pendingPhotoFiles = [];
      var postRecoveryUiVisible = false;
      var postRecoveryInFlight = false;
      var lastCommentsSnapshot = null;

      function setPostPreviewLink(url) {
        channelPostUrl = url && String(url).trim() ? String(url).trim() : null;
        if (!postPreviewBtnEl) return;
        if (channelPostUrl) {
          postPreviewBtnEl.classList.add('has-channel-link');
          if (postPreviewActionEl) postPreviewActionEl.textContent = 'В канале';
        } else {
          postPreviewBtnEl.classList.remove('has-channel-link');
          if (postPreviewActionEl) postPreviewActionEl.textContent = 'Подробнее';
        }
      }

      function setPostPreviewReady(ready) {
        postPreviewReady = !!ready;
        if (!postPreviewBtnEl) return;
        if (ready) {
          postPreviewBtnEl.classList.add('clickable');
          postPreviewBtnEl.removeAttribute('disabled');
        } else {
          postPreviewBtnEl.classList.remove('clickable');
          postPreviewBtnEl.setAttribute('disabled', 'disabled');
        }
      }

      function openExternalUrl(url) {
        if (!url) return false;
        try {
          var bridge = getWebAppBridge();
          if (bridge) {
            if (typeof bridge.openMaxLink === 'function') {
              bridge.openMaxLink(url);
              return true;
            }
            if (typeof bridge.openLink === 'function') {
              bridge.openLink(url);
              return true;
            }
          }
        } catch (err) {}
        try {
          window.open(url, '_blank');
          return true;
        } catch (e2) {}
        window.location.href = url;
        return true;
      }

      function showPostDetailOverlay() {
        if (!postDetailOverlayEl || !currentPostSnapshot) return;
        var snap = currentPostSnapshot;
        if (postDetailTitleEl) {
          postDetailTitleEl.textContent = snap.channel_title || 'Пост канала';
        }
        if (postDetailTextEl) {
          postDetailTextEl.textContent =
            snap.text && snap.text.trim() ? normalizeDisplayText(snap.text) : 'Текст поста отсутствует';
        }
        if (postDetailImgEl) {
          if (snap.photo_url) {
            postDetailImgEl.src = snap.photo_url;
            postDetailImgEl.classList.add('show');
          } else {
            postDetailImgEl.removeAttribute('src');
            postDetailImgEl.classList.remove('show');
          }
        }
        if (postDetailOpenChannelEl) {
          if (channelPostUrl) {
            postDetailOpenChannelEl.classList.remove('hidden');
          } else {
            postDetailOpenChannelEl.classList.add('hidden');
          }
        }
        postDetailOverlayEl.classList.remove('hidden');
        postDetailOverlayEl.classList.add('open');
        postDetailOverlayEl.setAttribute('aria-hidden', 'false');
      }

      function hidePostDetailOverlay() {
        if (!postDetailOverlayEl) return;
        postDetailOverlayEl.classList.add('hidden');
        postDetailOverlayEl.classList.remove('open');
        postDetailOverlayEl.setAttribute('aria-hidden', 'true');
      }

      function fetchChannelPostUrl() {
        var ids = resolveLookupIds();
        if (!ids.postId) return Promise.resolve(null);
        return fetch(
          '/api/post/' + encodeURIComponent(ids.postId) + '/channel-url' + postApiQuery(),
          { headers: miniappLookupHeaders() },
        )
          .then(function (r) {
            if (!r.ok) return null;
            return r.json();
          })
          .then(function (data) {
            var url = data && data.url && String(data.url).trim() ? String(data.url).trim() : null;
            if (url) {
              setPostPreviewLink(url);
            }
            return url;
          })
          .catch(function () {
            return null;
          });
      }

      function openChannelPost() {
        if (!postPreviewReady) return;
        function afterUrl(url) {
          if (url && openExternalUrl(url)) {
            hidePostDetailOverlay();
            return;
          }
          showPostDetailOverlay();
        }
        if (channelPostUrl) {
          afterUrl(channelPostUrl);
          return;
        }
        fetchChannelPostUrl().then(afterUrl);
      }

      function setErr(msg, fallback) {
        errEl.textContent = msg ? formatUserError(msg, fallback || 'Не удалось выполнить действие. Попробуйте ещё раз.') : '';
      }

      function setPostRecoveryStatus(text, isError) {
        var statusEl = document.getElementById('postRecoveryStatus');
        if (!statusEl) return;
        var shown = text || '';
        if (isError) {
          shown = formatUserError(text, 'Не удалось восстановить пост. Попробуйте ещё раз.');
        }
        statusEl.textContent = shown;
        statusEl.classList.toggle('is-error', !!isError);
      }

      function showPostRecoveryCard() {
        if (!feedEl) return;
        postRecoveryUiVisible = true;
        setErr('');
        if (composerWrapEl) composerWrapEl.style.display = 'none';
        if (replyBannerEl) hideReplyBanner();
        feedEl.innerHTML =
          '<div class="post-missing-card">' +
          '<img class="post-missing-illustration" src="/miniapp/assets/post-missing-max.png" alt="Грустный MAX ищет пост" />' +
          '<div class="post-missing-emoji">🕵️‍♂️</div>' +
          '<div class="post-missing-title">Упс, что я не найду данный пост, эх опять этот МАКС.</div>' +
          '<div class="post-missing-text">Нажмите «Обновить», и я попробую вернуть кнопку именно для этого поста. Без общей паники и системных страшилок.</div>' +
          '<button type="button" class="post-missing-refresh" id="postRecoveryRefreshBtn">Обновить</button>' +
          '<div class="post-missing-status" id="postRecoveryStatus"></div>' +
          '</div>';
        var btn = document.getElementById('postRecoveryRefreshBtn');
        if (btn && btn.dataset.bound !== '1') {
          btn.dataset.bound = '1';
          btn.addEventListener('click', refreshMissingPost);
        }
      }

      function hidePostRecoveryCard() {
        if (!postRecoveryUiVisible) return;
        postRecoveryUiVisible = false;
        if (composerWrapEl) composerWrapEl.style.display = '';
      }

      function refreshMissingPost() {
        if (postRecoveryInFlight) return Promise.resolve(false);
        var btn = document.getElementById('postRecoveryRefreshBtn');
        var ids = resolveLookupIds();
        if (!ids.postId) {
          setPostRecoveryStatus(
            'Не удалось определить пост. Откройте комментарии ещё раз из кнопки под публикацией.',
            true,
          );
          return Promise.resolve(false);
        }

        postRecoveryInFlight = true;
        if (btn) {
          btn.disabled = true;
          btn.textContent = 'Обновляю…';
        }
        setPostRecoveryStatus('Пинаю MAX аккуратно, чтобы вернуть именно этот пост…', false);

        return fetch('/api/post/' + encodeURIComponent(ids.postId) + '/refresh' + postApiQuery(), {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, miniappLookupHeaders()),
        })
          .then(function (r) {
            return parseApiJsonResponse(r).then(function (j) {
              if (!r.ok) {
                throw new Error(
                  (j && j.error) ||
                    (r.status === 404
                      ? 'Пост пока прячется. Дайте MAX секунду и нажмите ещё раз.'
                      : 'Не получилось обновить пост'),
                );
              }
              return j || {};
            });
          })
          .then(function (data) {
            if (data.post_id && data.post_id !== postId) {
              postId = data.post_id;
              currentPostId = data.post_id;
            }
            if (data.chat_id) {
              chatId = String(data.chat_id);
              params.set('chat_id', chatId);
              mergedParams.set('chat_id', chatId);
            }
            if (data.message_mid) {
              params.set('message_mid', String(data.message_mid));
              mergedParams.set('message_mid', String(data.message_mid));
            }
            setPostRecoveryStatus('Нашёл следы поста, перезагружаю страницу комментариев…', false);
            return loadPost().then(function (ok) {
              if (!ok) {
                throw new Error('Почти получилось, но пост ещё не прогрузился. Нажмите «Обновить» ещё раз.');
              }
              return loadComments(true);
            });
          })
          .catch(function (e) {
            setPostRecoveryStatus(e, true);
            return false;
          })
          .finally(function () {
            postRecoveryInFlight = false;
            if (btn) {
              btn.disabled = false;
              btn.textContent = 'Обновить';
            }
          });
      }

      function resizeComposerInput() {
        if (!inputEl) return;
        inputEl.style.height = 'auto';
        var next = Math.min(inputEl.scrollHeight, COMPOSER_INPUT_MAX_HEIGHT);
        inputEl.style.height = Math.max(40, next) + 'px';
        inputEl.style.overflowY = inputEl.scrollHeight > COMPOSER_INPUT_MAX_HEIGHT ? 'auto' : 'hidden';
      }

      function clearComposerInput() {
        if (!inputEl) return;
        inputEl.value = '';
        resizeComposerInput();
      }

      function updateSendEnabled() {
        var hasText = !!inputEl.value.trim();
        var hasPhotos = pendingPhotoFiles.length > 0;
        sendBtn.disabled = !hasText && !hasPhotos;
      }

      if (!postId) {
        setErr('Не удалось определить пост');
        return;
      }
      if (!chatId) {
        setErr('Не удалось определить канал');
        return;
      }
      if (!userId || !String(userId).trim()) {
        setErr('Войдите через MAX или Telegram');
        return;
      }

      function esc(s) {
        return String(s)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
      }

      /** NFKC: superscript/subscript digits etc. -> normal ASCII so system font does not look broken. */
      function normalizeDisplayText(s) {
        if (s == null) return '';
        try {
          return String(s).normalize('NFKC');
        } catch (_) {
          return String(s);
        }
      }

      function escDisplay(s) {
        return esc(normalizeDisplayText(s));
      }

      function cssEsc(s) {
        var v = String(s);
        if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
          return CSS.escape(v);
        }
        return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      }

      function initials(name) {
        var t = String(name || '').trim();
        if (!t) return '?';
        var parts = t.split(/\s+/);
        if (parts.length >= 2) {
          return (parts[0][0] + parts[1][0]).toUpperCase();
        }
        return t.slice(0, 2).toUpperCase();
      }

      var currentUserPhotoUrl = getBridgeUserPhotoUrl(user);

      function setAvatarEl(el, photoUrl, fallbackName) {
        if (!el) return;
        var url = photoUrl && String(photoUrl).trim();
        if (url) {
          el.innerHTML = '<img src="' + esc(url) + '" alt="" />';
        } else {
          el.textContent = initials(fallbackName);
        }
      }

      function avatarBlockHtml(photoUrl, fallbackName) {
        var url = photoUrl && String(photoUrl).trim();
        if (url) {
          return '<img src="' + esc(url) + '" alt="" />';
        }
        return esc(initials(fallbackName));
      }

      function normalizePhotoUrls(value) {
        if (!Array.isArray(value)) return [];
        var out = [];
        value.forEach(function (v) {
          if (typeof v !== 'string') return;
          var t = v.trim();
          if (!t) return;
          out.push(t);
        });
        return out.slice(0, 10);
      }

      function buildMediaGridHtml(photoUrls) {
        var urls = normalizePhotoUrls(photoUrls);
        if (!urls.length) return '';
        var imgs = urls
          .map(function (u) {
            return '<img class="media-zoomable" src="' + esc(u) + '" alt="Фото" loading="lazy" />';
          })
          .join('');
        return '<div class="media-grid">' + imgs + '</div>';
      }

      var photoViewerOverlayEl = document.getElementById('photoViewerOverlay');
      var photoViewerImgEl = document.getElementById('photoViewerImg');
      var photoViewerCloseEl = document.getElementById('photoViewerClose');
      var photoViewerPrevEl = document.getElementById('photoViewerPrev');
      var photoViewerNextEl = document.getElementById('photoViewerNext');
      var photoViewerCounterEl = document.getElementById('photoViewerCounter');
      var photoViewerUrls = [];
      var photoViewerIndex = 0;

      function photoViewerSrc(img) {
        return (img && (img.getAttribute('src') || img.src || '')).trim();
      }

      function collectZoomableUrls(container) {
        if (!container) return [];
        var out = [];
        container.querySelectorAll('img.media-zoomable').forEach(function (img) {
          var s = photoViewerSrc(img);
          if (s) out.push(s);
        });
        return out;
      }

      function updatePhotoViewerUi() {
        if (!photoViewerImgEl) return;
        photoViewerImgEl.src = photoViewerUrls[photoViewerIndex] || '';
        var multi = photoViewerUrls.length > 1;
        if (photoViewerPrevEl) photoViewerPrevEl.classList.toggle('hidden', !multi);
        if (photoViewerNextEl) photoViewerNextEl.classList.toggle('hidden', !multi);
        if (photoViewerCounterEl) {
          if (multi) {
            photoViewerCounterEl.textContent =
              photoViewerIndex + 1 + ' / ' + photoViewerUrls.length;
            photoViewerCounterEl.classList.remove('hidden');
          } else {
            photoViewerCounterEl.textContent = '';
            photoViewerCounterEl.classList.add('hidden');
          }
        }
      }

      function openPhotoViewer(urls, startIndex) {
        if (!photoViewerOverlayEl || !photoViewerImgEl) return;
        var list = (urls || []).filter(function (u) {
          return typeof u === 'string' && u.trim();
        });
        if (!list.length) return;
        photoViewerUrls = list;
        photoViewerIndex = Math.max(0, Math.min(startIndex || 0, list.length - 1));
        updatePhotoViewerUi();
        photoViewerOverlayEl.classList.remove('hidden');
        photoViewerOverlayEl.setAttribute('aria-hidden', 'false');
        document.body.style.overflow = 'hidden';
      }

      function closePhotoViewer() {
        if (!photoViewerOverlayEl) return;
        photoViewerOverlayEl.classList.add('hidden');
        photoViewerOverlayEl.setAttribute('aria-hidden', 'true');
        photoViewerUrls = [];
        photoViewerIndex = 0;
        if (photoViewerImgEl) photoViewerImgEl.removeAttribute('src');
        document.body.style.overflow = '';
      }

      function shiftPhotoViewer(delta) {
        if (photoViewerUrls.length < 2) return;
        photoViewerIndex =
          (photoViewerIndex + delta + photoViewerUrls.length) % photoViewerUrls.length;
        updatePhotoViewerUi();
      }

      function openPhotoViewerFromImg(img) {
        if (!img) return;
        var grid = img.closest('.media-grid');
        var urls = collectZoomableUrls(grid || img.parentElement);
        var idx = urls.indexOf(photoViewerSrc(img));
        openPhotoViewer(urls, idx >= 0 ? idx : 0);
      }

      if (photoViewerOverlayEl && photoViewerOverlayEl.dataset.bound !== '1') {
        photoViewerOverlayEl.dataset.bound = '1';
        if (photoViewerCloseEl) {
          photoViewerCloseEl.addEventListener('click', function (e) {
            e.stopPropagation();
            closePhotoViewer();
          });
        }
        if (photoViewerPrevEl) {
          photoViewerPrevEl.addEventListener('click', function (e) {
            e.stopPropagation();
            shiftPhotoViewer(-1);
          });
        }
        if (photoViewerNextEl) {
          photoViewerNextEl.addEventListener('click', function (e) {
            e.stopPropagation();
            shiftPhotoViewer(1);
          });
        }
        photoViewerOverlayEl.addEventListener('click', function (e) {
          if (
            e.target === photoViewerOverlayEl ||
            (e.target.classList && e.target.classList.contains('photo-viewer-stage'))
          ) {
            closePhotoViewer();
          }
        });
        if (photoViewerImgEl) {
          photoViewerImgEl.addEventListener('click', function (e) {
            e.stopPropagation();
          });
        }
        document.addEventListener('keydown', function (e) {
          if (!photoViewerOverlayEl || photoViewerOverlayEl.classList.contains('hidden')) return;
          if (e.key === 'Escape') closePhotoViewer();
          if (e.key === 'ArrowLeft') shiftPhotoViewer(-1);
          if (e.key === 'ArrowRight') shiftPhotoViewer(1);
        });
      }

      if (feedEl && feedEl.dataset.photoViewerBound !== '1') {
        feedEl.dataset.photoViewerBound = '1';
        feedEl.addEventListener('click', function (e) {
          var img = e.target.closest('.media-grid img.media-zoomable');
          if (!img) return;
          e.preventDefault();
          e.stopPropagation();
          openPhotoViewerFromImg(img);
        });
      }

      function renderComposerAttachments() {
        if (!composerAttachmentsEl) return;
        if (!pendingPhotoFiles.length) {
          composerAttachmentsEl.classList.remove('show');
          composerAttachmentsEl.innerHTML = '';
          return;
        }
        composerAttachmentsEl.classList.add('show');
        composerAttachmentsEl.innerHTML = pendingPhotoFiles
          .map(function (item, idx) {
            return (
              '<div class="composer-attachment">' +
              '<img class="media-zoomable" src="' +
              esc(item.previewUrl) +
              '" alt="Фото ' +
              (idx + 1) +
              '" />' +
              '<button type="button" data-remove-photo="' +
              idx +
              '" aria-label="Удалить фото">×</button>' +
              '</div>'
            );
          })
          .join('');
      }

      function clearComposerPhotos() {
        pendingPhotoFiles.forEach(function (item) {
          try {
            URL.revokeObjectURL(item.previewUrl);
          } catch (_) {}
        });
        pendingPhotoFiles = [];
        if (photoInputEl) photoInputEl.value = '';
        renderComposerAttachments();
      }

      resizeComposerInput();

      function updateBadgeFromCount(n) {
        var v = typeof n === 'number' && n >= 0 ? n : knownIds.size;
        countBadgeEl.textContent = 'Комментарии: ' + String(v);
      }

      function setChannelHeader(title, avatarUrl) {
        var name = title && String(title).trim() ? title.trim() : 'Канал';
        chNameEl.textContent = name;
        if (avatarUrl) {
          chAvatarEl.innerHTML = '<img src="' + esc(avatarUrl) + '" alt="" />';
        } else {
          chAvatarEl.textContent = initials(name);
        }
      }

      function elFromHTML(html) {
        var d = document.createElement('div');
        d.innerHTML = html.trim();
        return d.firstChild;
      }

      var RU_MONTHS_GEN = [
        'января',
        'февраля',
        'марта',
        'апреля',
        'мая',
        'июня',
        'июля',
        'августа',
        'сентября',
        'октября',
        'ноября',
        'декабря',
      ];

      function pad2(n) {
        return (n < 10 ? '0' : '') + n;
      }

      function parseCommentTimestamp(raw) {
        if (raw == null || raw === '') return null;
        var d = new Date(String(raw));
        return isNaN(d.getTime()) ? null : d;
      }

      function dateKeyLocal(d) {
        if (!d) return '';
        return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
      }

      function formatCommentClock(d) {
        if (!d) return '—';
        return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
      }

      function formatDateDividerLabel(d) {
        if (!d) return '';
        var now = new Date();
        var key = dateKeyLocal(d);
        if (key === dateKeyLocal(now)) return 'Сегодня';
        var yest = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
        if (key === dateKeyLocal(yest)) return 'Вчера';
        var day = d.getDate();
        var mon = RU_MONTHS_GEN[d.getMonth()];
        if (d.getFullYear() === now.getFullYear()) return day + ' ' + mon;
        return day + ' ' + mon + ' ' + d.getFullYear();
      }

      function buildDateDividerNode(d) {
        var label = formatDateDividerLabel(d);
        if (!label) return null;
        return elFromHTML(
          '<div class="date-divider" role="separator"><span>' + esc(label) + '</span></div>'
        );
      }

      function maybePrependDateDividerBeforeComment(commentDate) {
        if (!commentDate) return;
        var key = dateKeyLocal(commentDate);
        if (!key) return;
        var lastGroup = feedEl.querySelector('.comment-group:last-of-type');
        var prevKey = lastGroup ? lastGroup.getAttribute('data-date-key') || '' : '';
        if (prevKey === key) return;
        var div = buildDateDividerNode(commentDate);
        if (div) feedEl.appendChild(div);
      }

      function buildAdminActionsHtml(commentId, kind) {
        if (!isAdmin) return '';
        var labelEdit = kind === 'reply' ? 'Изменить ответ' : 'Изменить';
        var labelDel = kind === 'reply' ? 'Удалить ответ' : 'Удалить';
        var extraClass = kind === 'reply' ? ' reply-actions' : '';
        var editAttr = kind === 'reply' ? 'data-edit-reply' : 'data-edit-comment';
        var delAttr = kind === 'reply' ? 'data-delete-reply' : 'data-delete-comment';
        return (
          '<div class="admin-actions admin-context-menu' +
          extraClass +
          '" data-admin-actions="' +
          esc(commentId) +
          '" data-admin-menu-kind="' +
          (kind === 'reply' ? 'reply' : 'comment') +
          '">' +
          '<button type="button" class="admin-act-btn" ' +
          editAttr +
          '="' +
          esc(commentId) +
          '">' +
          labelEdit +
          '</button>' +
          '<button type="button" class="admin-act-btn danger" ' +
          delAttr +
          '="' +
          esc(commentId) +
          '">' +
          labelDel +
          '</button>' +
          '</div>' +
          '<div class="admin-edit-inline" data-admin-edit-box="' +
          esc(commentId) +
          '" data-edit-kind="' +
          kind +
          '">' +
          '<textarea data-admin-edit-input="' +
          esc(commentId) +
          '"></textarea>' +
          '<button type="button" class="admin-edit-save" data-admin-edit-save="' +
          esc(commentId) +
          '">Сохранить</button>' +
          '</div>'
        );
      }

      function listCommentReplies(c) {
        if (Array.isArray(c.replies) && c.replies.length) {
          return c.replies;
        }
        if (c.reply) {
          return [c.reply];
        }
        return [];
      }

      function channelDisplayName() {
        var name =
          chNameEl && chNameEl.textContent ? String(chNameEl.textContent).trim() : '';
        return name || 'Канал';
      }

      function channelAvatarBlockHtml() {
        var name = channelDisplayName();
        if (chAvatarEl) {
          var img = chAvatarEl.querySelector('img');
          if (img) {
            var src = img.getAttribute('src') || img.src || '';
            if (src) {
              return '<img src="' + esc(src) + '" alt="" />';
            }
          }
        }
        return esc(initials(name));
      }

      function commentQuoteSnippet(c) {
        var t = c && c.text ? String(c.text).trim() : '';
        if (t) return t;
        if (c && Array.isArray(c.photo_urls) && c.photo_urls.length) return 'Фото';
        return '';
      }

      function buildReplyQuoteHtml(replyToUsername, replyToText) {
        var who = replyToUsername ? String(replyToUsername).trim() : 'Пользователь';
        var raw = replyToText ? String(replyToText).trim() : '';
        var snip = raw;
        if (snip.length > 140) {
          snip = snip.slice(0, 137) + '…';
        }
        return (
          '<div class="tg-reply-to">' +
          '<div class="tg-reply-to-name">' +
          escDisplay(who) +
          '</div>' +
          (snip
            ? '<div class="tg-reply-to-text">' + escDisplay(snip) + '</div>'
            : '<div class="tg-reply-to-text">Комментарий</div>') +
          '</div>'
        );
      }

      function buildChannelMsgHtml(
        reply,
        commentId,
        isLastReply,
        showChannelAvatar,
        replyToUsername,
        replyToText,
        adminMenuKind
      ) {
        var adminTrim =
          reply && typeof reply.admin_name === 'string' ? reply.admin_name.trim() : '';
        var replyNameRaw = adminTrim || channelDisplayName();
        var replyLabel = escDisplay(replyNameRaw);
        var menuKind = adminMenuKind || 'reply';
        var adminReplyActs = isLastReply ? buildAdminActionsHtml(commentId, menuKind) : '';
        var replyT = reply && reply.timestamp ? parseCommentTimestamp(reply.timestamp) : null;
        var replyClock = formatCommentClock(replyT);
        var replyText = reply && typeof reply.text === 'string' ? reply.text : '';
        var replyMedia = buildMediaGridHtml(reply && reply.photo_urls);
        var rid =
          reply && reply.reply_id
            ? String(reply.reply_id)
            : reply && reply.timestamp
              ? String(reply.timestamp)
              : '';
        var lastCls = isLastReply ? ' msg-channel-last' : '';
        var stackCls = showChannelAvatar ? '' : ' msg-channel-stacked';
        var nameHtml = showChannelAvatar
          ? '<div class="tg-name">' + replyLabel + '</div>'
          : '';
        var quoteHtml = '';
        if (replyToUsername || replyToText) {
          quoteHtml = buildReplyQuoteHtml(replyToUsername, replyToText);
        }
        return (
          '<div class="feed-msg msg-channel msg-out' +
          lastCls +
          stackCls +
          '" data-reply-id="' +
          esc(rid) +
          '">' +
          '<div class="av av-ch">' +
          (showChannelAvatar ? channelAvatarBlockHtml() : '') +
          '</div>' +
          '<div class="tg-bubble bubble-ch">' +
          nameHtml +
          quoteHtml +
          (replyText ? '<div class="tg-text">' + escDisplay(replyText) + '</div>' : '') +
          replyMedia +
          '<span class="tg-time">' +
          esc(replyClock) +
          '</span>' +
          '</div>' +
          adminReplyActs +
          '</div>'
        );
      }

      function resolveCommentAvatarUrl(c) {
        if (c.avatar_url && String(c.avatar_url).trim()) {
          return String(c.avatar_url).trim();
        }
        if (c.user_id != null && String(c.user_id) === String(userId) && currentUserPhotoUrl) {
          return currentUserPhotoUrl;
        }
        return null;
      }

      function buildChannelOnlyCommentGroup(c) {
        var synthetic = {
          text: c.text || '',
          timestamp: c.timestamp,
          admin_name: c.username,
          photo_urls: c.photo_urls,
          reply_id: c.comment_id,
        };
        var cts = parseCommentTimestamp(c.timestamp);
        var dk = cts ? dateKeyLocal(cts) : '';
        var dkAttr = dk ? ' data-date-key="' + esc(dk) + '"' : '';
        var channelHtml = buildChannelMsgHtml(
          synthetic,
          c.comment_id,
          true,
          true,
          null,
          null,
          'comment'
        );
        return (
          '<div class="comment-group has-channel-reply" data-comment-id="' +
          esc(c.comment_id) +
          '"' +
          dkAttr +
          '>' +
          channelHtml +
          '</div>'
        );
      }

      function buildUserBlock(c) {
        if (c.posted_as_channel) {
          return buildChannelOnlyCommentGroup(c);
        }
        var av = avatarBlockHtml(resolveCommentAvatarUrl(c), c.username);
        var commentMedia = buildMediaGridHtml(c.photo_urls);
        var replies = listCommentReplies(c);
        var replyHtml = '';
        if (replies.length) {
          replyHtml = replies
            .map(function (r, idx) {
              return buildChannelMsgHtml(
                r,
                c.comment_id,
                idx === replies.length - 1,
                idx === 0,
                c.username,
                commentQuoteSnippet(c)
              );
            })
            .join('');
        }
        var commentAdminActs = buildAdminActionsHtml(c.comment_id, 'comment');
        var cts = parseCommentTimestamp(c.timestamp);
        var timeShown = formatCommentClock(cts);
        var dk = cts ? dateKeyLocal(cts) : '';
        var dkAttr = dk ? ' data-date-key="' + esc(dk) + '"' : '';
        var cidStr = String(c.comment_id || '');
        var groupExtraCls = replies.length ? ' has-channel-reply' : '';
        var replyBelow =
          isAdmin && cidStr.indexOf('temp-') !== 0
            ? '<div class="msg-reply-row">' +
              '<button type="button" class="reply-below-btn" data-reply-comment="' +
              esc(c.comment_id) +
              '" aria-label="Ответить от имени канала">Ответить</button>' +
              '</div>'
            : '';
        var isOwnComment =
          c.user_id != null && String(c.user_id) === String(userId);
        var userMsgCls = 'feed-msg msg-user ' + (isOwnComment ? 'msg-out' : 'msg-in');
        var nameHtml = isOwnComment
          ? ''
          : '<div class="tg-name">' + escDisplay(c.username) + '</div>';
        return (
          '<div class="comment-group' +
          groupExtraCls +
          '" data-comment-id="' +
          esc(c.comment_id) +
          '"' +
          dkAttr +
          '>' +
          '<div class="' +
          userMsgCls +
          '">' +
          '<div class="av av-u">' +
          av +
          '</div>' +
          '<div class="tg-bubble bubble-u">' +
          nameHtml +
          (c.text ? '<div class="tg-text">' + escDisplay(c.text) + '</div>' : '') +
          commentMedia +
          '<span class="tg-time">' +
          esc(timeShown) +
          '</span>' +
          '</div>' +
          commentAdminActs +
          '</div>' +
          replyBelow +
          replyHtml +
          '</div>'
        );
      }

      var commentActionsTouchBound = false;

      function closeAllAdminContextMenus() {
        feedEl.querySelectorAll('.comment-group.admin-menu-open').forEach(function (g) {
          g.classList.remove('admin-menu-open', 'admin-menu--comment', 'admin-menu--reply');
        });
      }

      function openAdminContextMenu(node, which) {
        closeAllAdminContextMenus();
        node.classList.add(
          'admin-menu-open',
          which === 'reply' ? 'admin-menu--reply' : 'admin-menu--comment'
        );
      }

      function wireCommentNode(node) {
        if (isAdmin) {
          var pressTimer = null;
          var msgEl = node.querySelector('.msg-user');
          if (msgEl && msgEl.dataset.modWired !== '1') {
            msgEl.dataset.modWired = '1';
            var swipe = { active: false, sx: 0, sy: 0 };
            msgEl.addEventListener(
              'touchstart',
              function (e) {
                clearTimeout(pressTimer);
                if (e.touches && e.touches.length === 1) {
                  swipe.active = true;
                  swipe.sx = e.touches[0].clientX;
                  swipe.sy = e.touches[0].clientY;
                } else {
                  swipe.active = false;
                }
                pressTimer = window.setTimeout(function () {
                  openAdminContextMenu(node, 'comment');
                }, 500);
              },
              { passive: true }
            );
            msgEl.addEventListener(
              'touchmove',
              function (e) {
                if (!swipe.active || !e.touches || e.touches.length !== 1) return;
                var dx = e.touches[0].clientX - swipe.sx;
                var dy = e.touches[0].clientY - swipe.sy;
                if (dx < -14 && Math.abs(dx) > Math.abs(dy) * 1.15) {
                  clearTimeout(pressTimer);
                  node.classList.add('swipe-reply');
                } else {
                  if (dx > -10) node.classList.remove('swipe-reply');
                  if (Math.abs(dx) > 26 || Math.abs(dy) > 26) {
                    clearTimeout(pressTimer);
                  }
                }
              },
              { passive: true }
            );
            msgEl.addEventListener(
              'touchend',
              function (e) {
                clearTimeout(pressTimer);
                if (swipe.active && e.changedTouches && e.changedTouches.length === 1) {
                  var dx = e.changedTouches[0].clientX - swipe.sx;
                  var dy = e.changedTouches[0].clientY - swipe.sy;
                  if (dx < -56 && Math.abs(dx) > Math.abs(dy) + 18) {
                    var cidSwipe = node.getAttribute('data-comment-id');
                    var unameEl = node.querySelector('.tg-name, .uname');
                    var unameSwipe = unameEl
                      ? String(unameEl.textContent || '').trim()
                      : 'пользователю';
                    activateReplyContext(cidSwipe, unameSwipe || 'пользователю');
                  }
                }
                swipe.active = false;
                node.classList.remove('swipe-reply');
              },
              { passive: true }
            );
            msgEl.addEventListener('contextmenu', function (e) {
              e.preventDefault();
              openAdminContextMenu(node, 'comment');
            });
          }
          var replyEl = node.querySelector('.msg-channel.msg-channel-last');
          if (replyEl && replyEl.dataset.channelWired !== '1') {
            replyEl.dataset.channelWired = '1';
            var replyTouch = { sx: 0, sy: 0, active: false };
            replyEl.addEventListener(
              'touchstart',
              function (e) {
                clearTimeout(pressTimer);
                if (e.touches && e.touches.length === 1) {
                  replyTouch.sx = e.touches[0].clientX;
                  replyTouch.sy = e.touches[0].clientY;
                  replyTouch.active = true;
                } else {
                  replyTouch.active = false;
                }
                pressTimer = window.setTimeout(function () {
                  openAdminContextMenu(node, 'reply');
                }, 500);
              },
              { passive: true }
            );
            replyEl.addEventListener(
              'touchmove',
              function (e) {
                if (!replyTouch.active || !e.touches || e.touches.length !== 1) return;
                var dx = e.touches[0].clientX - replyTouch.sx;
                var dy = e.touches[0].clientY - replyTouch.sy;
                if (Math.abs(dx) > 26 || Math.abs(dy) > 26) {
                  clearTimeout(pressTimer);
                }
              },
              { passive: true }
            );
            replyEl.addEventListener(
              'touchend',
              function () {
                clearTimeout(pressTimer);
                replyTouch.active = false;
              },
              { passive: true }
            );
            replyEl.addEventListener('contextmenu', function (e) {
              e.preventDefault();
              openAdminContextMenu(node, 'reply');
            });
          }
          var replyQuick = node.querySelector('[data-reply-comment]');
          if (replyQuick && replyQuick.dataset.replyWired !== '1') {
            replyQuick.dataset.replyWired = '1';
            replyQuick.addEventListener('click', function (e) {
              e.preventDefault();
              e.stopPropagation();
              clearTimeout(pressTimer);
              closeAllAdminContextMenus();
              var rid = replyQuick.getAttribute('data-reply-comment');
              var unameEl = node.querySelector('.tg-name, .uname');
              var nm = unameEl ? String(unameEl.textContent || '').trim() : '';
              activateReplyContext(rid, nm || 'пользователю');
            });
          }
          if (!commentActionsTouchBound) {
            commentActionsTouchBound = true;
            function closeAdminMenuIfOutside(e) {
              var t = e.target;
              if (
                t &&
                t.closest &&
                (t.closest('.admin-actions') ||
                  t.closest('.admin-confirm-overlay') ||
                  t.closest('.admin-confirm-card'))
              ) {
                return;
              }
              feedEl.querySelectorAll('.comment-group.admin-menu-open').forEach(function (g) {
                if (!g.contains(t)) {
                  g.classList.remove('admin-menu-open', 'admin-menu--comment', 'admin-menu--reply');
                }
              });
            }
            document.addEventListener('touchstart', closeAdminMenuIfOutside, true);
            document.addEventListener('mousedown', closeAdminMenuIfOutside, true);
          }
        }
        wireAdminModeration(node);
      }

      var adminConfirmOverlayEl = document.getElementById('adminConfirmOverlay');
      var adminConfirmMessageEl = document.getElementById('adminConfirmMessage');
      var adminConfirmOkEl = document.getElementById('adminConfirmOk');
      var adminConfirmCancelEl = document.getElementById('adminConfirmCancel');
      var adminConfirmCallback = null;

      function hideAdminConfirm() {
        if (!adminConfirmOverlayEl) return;
        adminConfirmOverlayEl.classList.add('hidden');
        adminConfirmOverlayEl.setAttribute('aria-hidden', 'true');
        adminConfirmCallback = null;
      }

      function showAdminConfirm(message, onOk) {
        if (!adminConfirmOverlayEl) {
          if (onOk) onOk();
          return;
        }
        adminConfirmCallback = onOk;
        if (adminConfirmMessageEl) adminConfirmMessageEl.textContent = message;
        adminConfirmOverlayEl.classList.remove('hidden');
        adminConfirmOverlayEl.setAttribute('aria-hidden', 'false');
      }

      if (adminConfirmOkEl) {
        adminConfirmOkEl.addEventListener('click', function () {
          var cb = adminConfirmCallback;
          hideAdminConfirm();
          if (cb) cb();
        });
      }
      if (adminConfirmCancelEl) {
        adminConfirmCancelEl.addEventListener('click', hideAdminConfirm);
      }
      if (adminConfirmOverlayEl) {
        adminConfirmOverlayEl.addEventListener('click', function (e) {
          if (e.target === adminConfirmOverlayEl) hideAdminConfirm();
        });
      }

      function adminApiBase(cid) {
        return {
          comment_id: cid,
          post_id: currentPostId || postId,
          chat_id: Number(chatId),
          user_id: Number(userId),
        };
      }

      function runAdminDeleteRequest(url, cid, block, btn, onSuccess) {
        btn.disabled = true;
        setErr('');
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(adminApiBase(cid)),
        })
          .then(function (r) {
            if (!r.ok) {
              return r.json().then(function (j) {
                throw new Error(j.error || String(r.status));
              });
            }
            return r.json();
          })
          .then(onSuccess)
          .catch(function (e) {
            setErr(e, 'Не удалось выполнить действие');
          })
          .finally(function () {
            btn.disabled = false;
          });
      }

      function wireAdminModeration(block) {
        if (!isAdmin) return;
        var cid = block.getAttribute('data-comment-id');
        if (!cid || cid.indexOf('temp-') === 0) return;

        block.querySelectorAll('.admin-actions.admin-context-menu').forEach(function (menu) {
          if (menu.dataset.menuShield === '1') return;
          menu.dataset.menuShield = '1';
          function stopMenuEvent(e) {
            // Не глушим клики по кнопкам меню — иначе «Удалить»/«Изменить» не срабатывают.
            if (e.target && e.target.closest && e.target.closest('.admin-act-btn')) return;
            e.stopPropagation();
          }
          menu.addEventListener('touchstart', stopMenuEvent, { passive: true, capture: true });
          menu.addEventListener('touchend', stopMenuEvent, { passive: true, capture: true });
          menu.addEventListener('mousedown', stopMenuEvent, true);
          menu.addEventListener('click', stopMenuEvent, true);
        });


        block.querySelectorAll('[data-edit-comment]').forEach(function (btn) {
          if (btn.dataset.actWired === '1') return;
          btn.dataset.actWired = '1';
          btn.addEventListener('click', function () {
            block.classList.remove('admin-menu-open', 'admin-menu--comment', 'admin-menu--reply');
            var box = block.querySelector(
              '[data-admin-edit-box="' + cssEsc(cid) + '"][data-edit-kind="comment"]'
            );
            var ta = box && box.querySelector('textarea');
            var utext = block.querySelector('.bubble-u .tg-text, .bubble-u .utext');
            if (!box || !ta) return;
            ta.value = utext ? utext.textContent || '' : '';
            box.classList.add('open');
            ta.focus();
          });
        });

        block.querySelectorAll('[data-edit-reply]').forEach(function (btn) {
          if (btn.dataset.actWired === '1') return;
          btn.dataset.actWired = '1';
          btn.addEventListener('click', function () {
            block.classList.remove('admin-menu-open', 'admin-menu--comment', 'admin-menu--reply');
            var box = block.querySelector(
              '[data-admin-edit-box="' + cssEsc(cid) + '"][data-edit-kind="reply"]'
            );
            var rtext = block.querySelector('.msg-channel.msg-channel-last .tg-text, .msg-channel.msg-channel-last .ctext');
            var ta = box && box.querySelector('textarea');
            var hasReplyMedia = !!block.querySelector('.msg-channel.msg-channel-last .media-grid');
            if (!box || !ta) return;
            if (rtext) {
              ta.value = rtext.textContent || '';
            } else if (hasReplyMedia) {
              ta.value = '';
            } else {
              return;
            }
            box.classList.add('open');
            ta.focus();
          });
        });

        block.querySelectorAll('[data-admin-edit-save]').forEach(function (btn) {
          if (btn.dataset.actWired === '1') return;
          btn.dataset.actWired = '1';
          btn.addEventListener('click', function () {
            var box = btn.closest('[data-admin-edit-box]');
            if (!box) return;
            var kind = box.getAttribute('data-edit-kind');
            var ta = box.querySelector('textarea');
            var text = ta && ta.value.trim();
            if (!text && kind !== 'reply') return;
            if (!text && kind === 'reply') {
              var hasReplyImg = !!block.querySelector('.msg-channel.msg-channel-last .media-grid');
              if (!hasReplyImg) return;
            }
            btn.disabled = true;
            setErr('');
            var url = kind === 'reply' ? '/api/reply' : '/api/comment';
            var body =
              kind === 'reply'
                ? Object.assign(adminApiBase(cid), {
                    admin_text: text,
                    admin_name: adminNameForReply,
                  })
                : Object.assign(adminApiBase(cid), { text: text });
            fetch(url, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            })
              .then(function (r) {
                if (!r.ok) {
                  return r.json().then(function (j) {
                    throw new Error(j.error || String(r.status));
                  });
                }
                return r.json();
              })
              .then(function (updated) {
                box.classList.remove('open');
                if (ta) ta.value = '';
                block.classList.remove('admin-menu-open', 'admin-menu--comment', 'admin-menu--reply');
                mergeOrUpdateComment(updated);
                scrollToBottom();
              })
              .catch(function (e) {
                setErr(e, 'Не удалось выполнить действие');
              })
              .finally(function () {
                btn.disabled = false;
              });
          });
        });

        block.querySelectorAll('[data-delete-comment]').forEach(function (btn) {
          if (btn.dataset.delWired === '1') return;
          btn.dataset.delWired = '1';
          function doDeleteComment() {
            closeAllAdminContextMenus();
            runAdminDeleteRequest('/api/comment/delete', cid, block, btn, function (res) {
              knownIds.delete(cid);
              block.remove();
              if (typeof res.comment_count === 'number') {
                postCommentCount = res.comment_count;
                updateBadgeFromCount(postCommentCount);
              } else {
                bumpCommentCount(-1);
              }
              if (!feedEl.querySelector('.comment-group')) {
                feedEl.innerHTML = '<div class="feed-empty">Пока нет комментариев</div>';
              }
            });
          }
          function onDeleteCommentTap(e) {
            e.preventDefault();
            e.stopPropagation();
            showAdminConfirm('Удалить этот комментарий?', doDeleteComment);
          }
          btn.addEventListener('click', onDeleteCommentTap);
        });

        block.querySelectorAll('[data-delete-reply]').forEach(function (btn) {
          if (btn.dataset.delWired === '1') return;
          btn.dataset.delWired = '1';
          function doDeleteReply() {
            closeAllAdminContextMenus();
            runAdminDeleteRequest('/api/reply/delete', cid, block, btn, function (updated) {
              mergeOrUpdateComment(updated);
            });
          }
          function onDeleteReplyTap(e) {
            e.preventDefault();
            e.stopPropagation();
            showAdminConfirm('Удалить ответ канала?', doDeleteReply);
          }
          btn.addEventListener('click', onDeleteReplyTap);
        });
      }

      function hideReplyBanner() {
        replyContext = null;
        if (replyBannerEl) replyBannerEl.style.display = 'none';
        updateSendEnabled();
      }

      function showReplyBanner(name) {
        if (!replyBannerEl || !replyBannerNameEl) return;
        replyBannerNameEl.textContent = name || 'пользователю';
        replyBannerEl.style.display = 'block';
      }

      function activateReplyContext(commentId, targetName) {
        if (!commentId) return;
        replyContext = {
          comment_id: commentId,
          username: targetName || 'пользователю',
          post_id: currentPostId,
        };
        showReplyBanner(replyContext.username);
        inputEl.focus();
        updateSendEnabled();
      }

      function mergeOrUpdateComment(c) {
        var existing = feedEl.querySelector(
          '.comment-group[data-comment-id="' + cssEsc(c.comment_id) + '"]'
        );
        if (!existing) {
          maybePrependDateDividerBeforeComment(parseCommentTimestamp(c.timestamp));
          var node = elFromHTML(buildUserBlock(c));
          feedEl.appendChild(node);
          wireCommentNode(node);
          knownIds.add(c.comment_id);
          return;
        }
        var newReplies = listCommentReplies(c);
        var channelEls = existing.querySelectorAll('.msg-channel');
        var prevCount = channelEls.length;
        if (newReplies.length > prevCount) {
          for (var i = prevCount; i < newReplies.length; i++) {
            existing.insertAdjacentHTML(
              'beforeend',
              buildChannelMsgHtml(
                newReplies[i],
                c.comment_id,
                i === newReplies.length - 1,
                i === prevCount,
                c.username,
                commentQuoteSnippet(c)
              )
            );
          }
          existing.querySelectorAll('.msg-channel').forEach(function (el, idx, all) {
            if (idx < all.length - 1) {
              el.classList.remove('msg-channel-last');
              el.querySelectorAll('.admin-actions').forEach(function (a) {
                a.remove();
              });
            }
          });
          wireCommentNode(existing);
          return;
        }
        var fresh = elFromHTML(buildUserBlock(c));
        existing.replaceWith(fresh);
        wireCommentNode(fresh);
      }

      function renderInitial(list) {
        if (!feedEl) { console.error('renderInitial: feedEl is null'); return; }
        lastCommentsSnapshot = Array.isArray(list) ? list.slice() : [];
        knownIds.clear();
        feedEl.innerHTML = '';
        if (!list.length) {
          feedEl.innerHTML = '<div class="feed-empty">Пока нет комментариев</div>';
          return;
        }
        var frag = document.createDocumentFragment();
        var lastDayKey = null;
        list.forEach(function (c) {
          knownIds.add(c.comment_id);
          var cts = parseCommentTimestamp(c.timestamp);
          var dk = cts ? dateKeyLocal(cts) : '';
          if (dk && dk !== lastDayKey) {
            var divn = buildDateDividerNode(cts);
            if (divn) frag.appendChild(divn);
            lastDayKey = dk;
          }
          var node = elFromHTML(buildUserBlock(c));
          frag.appendChild(node);
          wireCommentNode(node);
        });
        feedEl.appendChild(frag);
      }

      function reconcileCommentsWithServer(list) {
        if (!Array.isArray(list)) return;
        var serverIds = new Set();
        list.forEach(function (c) {
          if (c && c.comment_id) serverIds.add(String(c.comment_id));
        });
        feedEl.querySelectorAll('.comment-group[data-comment-id]').forEach(function (node) {
          var id = node.getAttribute('data-comment-id');
          if (!id || String(id).indexOf('temp-') === 0) return;
          if (!serverIds.has(id)) {
            knownIds.delete(id);
            node.remove();
          }
        });
        if (!feedEl.querySelector('.comment-group') && list.length === 0) {
          feedEl.innerHTML = '<div class="feed-empty">Пока нет комментариев</div>';
        }
        appendNewOnly(list);
      }

      function appendNewOnly(list) {
        if (!Array.isArray(list)) return;
        var hadEmpty = !!feedEl.querySelector('.feed-empty');
        list.forEach(function (c) {
          if (knownIds.has(c.comment_id)) {
            mergeOrUpdateComment(c);
            return;
          }
          if (hadEmpty) {
            feedEl.innerHTML = '';
            hadEmpty = false;
          }
          maybePrependDateDividerBeforeComment(parseCommentTimestamp(c.timestamp));
          var node = elFromHTML(buildUserBlock(c));
          feedEl.appendChild(node);
          wireCommentNode(node);
          knownIds.add(c.comment_id);
          if (typeof postCommentCount === 'number') {
            postCommentCount += 1;
            updateBadgeFromCount(postCommentCount);
          }
        });
      }

      function resolveLookupIds() {
        var lookupPostId = postId;
        var lookupChatId = chatId;
        var lookupMid = params.get('message_mid');
        if ((!lookupPostId || !lookupChatId) && startParam) {
          var decoded = decodeStartParam(startParam);
          if (decoded) {
            if (decoded.post_id) lookupPostId = decoded.post_id;
            if (decoded.chat_id) lookupChatId = decoded.chat_id;
            if (decoded.message_mid) lookupMid = decoded.message_mid;
          }
        }
        return {
          postId: lookupPostId,
          chatId: lookupChatId,
          messageMid: lookupMid,
        };
      }

      function postApiQuery() {
        var ids = resolveLookupIds();
        var parts = [];
        if (inTelegram) parts.push('platform=telegram');
        if (ids.chatId) parts.push('chat_id=' + encodeURIComponent(ids.chatId));
        if (ids.messageMid) parts.push('message_mid=' + encodeURIComponent(ids.messageMid));
        return parts.length ? '?' + parts.join('&') : '';
      }

      function miniappLookupHeaders() {
        var hdr = {};
        if (inTelegram) hdr['X-Miniapp-Platform'] = 'telegram';
        // Only ASCII-safe values may be used as HTTP header values.
        // X-Miniapp-Start-Param is always ASCII (hex + base64url payload).
        if (startParam) {
          var spSafe = String(startParam).replace(/[^\x20-\x7E]/g, '');
          if (spSafe) hdr['X-Miniapp-Start-Param'] = spSafe;
        }
        // X-Miniapp-User-Id is a numeric string — always ASCII.
        if (userId && String(userId).trim()) hdr['X-Miniapp-User-Id'] = String(userId).trim();
        var tgUid = params.get('tg_uid');
        var tgExp = params.get('tg_exp');
        var tgSig = params.get('tg_sig');
        if (tgUid && /^\d+$/.test(String(tgUid))) hdr['X-Miniapp-Tg-Uid'] = String(tgUid);
        if (tgExp && /^\d+$/.test(String(tgExp))) hdr['X-Miniapp-Tg-Exp'] = String(tgExp);
        if (tgSig && /^[a-f0-9]{64}$/i.test(String(tgSig))) {
          hdr['X-Miniapp-Tg-Sig'] = String(tgSig).toLowerCase();
        }
        return hdr;
      }

      /** Parses API body; HTML error pages are logged and surfaced as a short user message. */
      function parseApiJsonResponse(r) {
        var ct = (r.headers.get('content-type') || '').toLowerCase();
        return r.text().then(function (text) {
          var trimmed = (text || '').trim();
          if (trimmed.charAt(0) === '<' || ct.indexOf('text/html') !== -1) {
            logMiniappError('api_html_response', { status: r.status, snippet: trimmed.slice(0, 200) });
            var err = new Error(
              r.status === 404
                ? 'Сервис временно недоступен. Попробуйте позже.'
                : 'Сервис временно недоступен. Попробуйте позже.',
            );
            err.code = 'api_html_response';
            err.httpStatus = r.status;
            throw err;
          }
          if (!trimmed) {
            return {};
          }
          try {
            return JSON.parse(trimmed);
          } catch (parseErr) {
            logMiniappError('api_invalid_json', { status: r.status, snippet: trimmed.slice(0, 200) });
            var err2 = new Error('Сервис временно недоступен. Попробуйте позже.');
            err2.code = 'api_invalid_json';
            throw err2;
          }
        });
      }

      function loadPost() {
        var ids = resolveLookupIds();
        if (!ids.postId) {
          setErr('Не удалось определить пост');
          postPreviewTextEl.textContent = '';
          return Promise.resolve(false);
        }
        hidePostRecoveryCard();
        setPostPreviewReady(false);
        postPreviewTextEl.textContent = 'Загрузка…';
        console.info('miniapp: post lookup request', {
          postId: ids.postId,
          chatId: ids.chatId,
          messageMid: ids.messageMid || null,
          startParam: startParam || null,
        });
        return fetch('/api/post/' + encodeURIComponent(ids.postId) + postApiQuery(), {
          headers: miniappLookupHeaders(),
        })
          .then(function (r) {
            return parseApiJsonResponse(r).then(function (p) {
              if (r.status === 404) {
                var notFoundErr = new Error('post_not_found');
                notFoundErr.code = 'post_not_found';
                throw notFoundErr;
              }
              if (!r.ok) {
                throw new Error((p && p.error) || 'Не удалось загрузить пост');
              }
              return p;
            });
          })
          .then(function (p) {
            hidePostRecoveryCard();
            if (p.post_id && p.post_id !== postId) {
              postId = p.post_id;
              currentPostId = p.post_id;
            }
            if (!chatId && p.chat_id) {
              chatId = String(p.chat_id);
              params.set('chat_id', chatId);
              mergedParams.set('chat_id', chatId);
            }
            setChannelHeader(p.channel_title, p.channel_avatar_url);
            currentPostSnapshot = {
              text: p.text || '',
              photo_url: p.photo_url || null,
              channel_title: p.channel_title || '',
            };
            postPreviewTextEl.textContent =
              p.text && p.text.trim() ? normalizeDisplayText(p.text) : '\u00a0';
            if (p.photo_url) {
              postThumbEl.src = p.photo_url;
              postThumbEl.classList.add('show');
            } else {
              postThumbEl.removeAttribute('src');
              postThumbEl.classList.remove('show');
            }
            if (typeof p.comment_count === 'number') {
              postCommentCount = p.comment_count;
              updateBadgeFromCount(postCommentCount);
            }
            setPostPreviewLink(p.channel_post_url || null);
            setPostPreviewReady(true);
            return true;
          })
          .catch(function (e) {
            if (e && e.code === 'post_not_found') {
              showPostRecoveryCard();
              return false;
            }
            setErr(e, 'Не удалось загрузить комментарии');
            postPreviewTextEl.textContent = '';
            currentPostSnapshot = null;
            setPostPreviewLink(null);
            setPostPreviewReady(false);
            return false;
          });
      }

      function refreshAdminStateFromServer() {
        if (isAdmin) return Promise.resolve(false);
        if (!userId || !String(userId).trim() || !chatId) return Promise.resolve(false);
        var url =
          '/api/user-status?user_id=' +
          encodeURIComponent(String(userId)) +
          (inTelegram ? '&platform=telegram' : '') +
          '&chat_id=' +
          encodeURIComponent(String(chatId));
        return fetch(url)
          .then(function (r) {
            if (!r.ok) return null;
            return r.json();
          })
          .then(function (data) {
            if (data && data.is_admin) {
              var promoted = promoteAdminMode();
              if (promoted && lastCommentsSnapshot && lastCommentsSnapshot.length) {
                renderInitial(lastCommentsSnapshot);
                scrollToBottom();
              }
              return promoted;
            }
            return false;
          })
          .catch(function () {
            return false;
          });
      }

      function loadComments(initial) {
        if (postRecoveryUiVisible) return Promise.resolve();
        var ids = resolveLookupIds();
        if (!ids.postId) return Promise.resolve();
        return fetch('/api/comments/' + encodeURIComponent(ids.postId) + postApiQuery(), {
          headers: miniappLookupHeaders(),
        })
          .then(function (r) {
            return parseApiJsonResponse(r).then(function (list) {
              if (r.status === 404) {
                var notFoundErr = new Error('post_not_found');
                notFoundErr.code = 'post_not_found';
                throw notFoundErr;
              }
              if (!r.ok) {
                throw new Error(
                  (list && list.error) || 'Не удалось загрузить комментарии',
                );
              }
              return list;
            });
          })
          .then(function (list) {
            var arr = Array.isArray(list) ? list : [];
            if (initial) {
              renderInitial(arr);
            } else {
              reconcileCommentsWithServer(arr);
            }
            if (postCommentCount == null) {
              updateBadgeFromCount(arr.length);
            }
            scrollToBottom();
          })
          .catch(function (e) {
            if (e && e.code === 'post_not_found') {
              showPostRecoveryCard();
              return;
            }
            setErr(e, 'Не удалось отправить комментарий');
          });
      }

      function bumpCommentCount(delta) {
        if (typeof postCommentCount === 'number') {
          postCommentCount += delta;
          updateBadgeFromCount(postCommentCount);
        } else {
          updateBadgeFromCount(null);
        }
      }

      function uploadComposerPhotos() {
        if (!pendingPhotoFiles.length) {
          return Promise.resolve([]);
        }
        var fd = new FormData();
        pendingPhotoFiles.forEach(function (item) {
          fd.append('photos', item.file);
        });
        return fetch('/api/upload-photos', {
          method: 'POST',
          body: fd,
        })
          .then(function (r) {
            return r.json().then(function (j) {
              if (!r.ok) throw new Error(j.error || String(r.status));
              return j;
            });
          })
          .then(function (data) {
            return Array.isArray(data.photo_urls) ? data.photo_urls : [];
          });
      }

      function submitComment() {
        if (!postId) {
          setErr('Не удалось определить пост');
          return;
        }
        if (!chatId) {
          setErr('Не удалось определить канал');
          return;
        }
        if (!userId || !String(userId).trim()) {
          setErr('Войдите через MAX или Telegram');
          return;
        }
        var text = inputEl.value.trim();
        if (!text && pendingPhotoFiles.length === 0) return;

        sendBtn.disabled = true;
        setErr('');

        var uploadPromise =
          pendingPhotoFiles.length > 0 ? uploadComposerPhotos() : Promise.resolve([]);

        uploadPromise
          .then(function (photoUrls) {
            var urls = Array.isArray(photoUrls) ? photoUrls : [];

            if (replyContext) {
              if (
                !replyContext.comment_id ||
                String(replyContext.comment_id).indexOf('temp-') === 0
              ) {
                setErr('Дождитесь отправки комментария');
                return Promise.reject(new Error('pending'));
              }
              return fetch('/api/reply', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  comment_id: replyContext.comment_id,
                  post_id: replyContext.post_id,
                  chat_id: Number(chatId),
                  user_id: Number(userId),
                  admin_text: text,
                  photo_urls: urls.length ? urls : undefined,
                }),
              })
                .then(function (r) {
                  if (!r.ok) {
                    return r.json().then(function (j) {
                      throw new Error(j.error || String(r.status));
                    });
                  }
                  return r.json();
                })
                .then(function (data) {
                  clearComposerPhotos();
                  clearComposerInput();
                  hideReplyBanner();
                  if (data && data.comment_id) {
                    mergeOrUpdateComment(data);
                    scrollToBottom();
                    return;
                  }
                  return loadComments(false);
                });
            }

            clearComposerPhotos();
            clearComposerInput();
            var tempId = 'temp-' + Date.now();
            var optimistic = {
              comment_id: tempId,
              user_id: Number(userId),
              username: isAdmin ? channelDisplayName() : username,
              text: text,
              timestamp: new Date().toISOString(),
              photo_urls: urls.length ? urls : undefined,
            };
            if (isAdmin) {
              optimistic.posted_as_channel = true;
            } else if (currentUserPhotoUrl) {
              optimistic.avatar_url = currentUserPhotoUrl;
            }
            if (feedEl.querySelector('.feed-empty')) {
              feedEl.innerHTML = '';
            }
            maybePrependDateDividerBeforeComment(parseCommentTimestamp(optimistic.timestamp));
            var node = elFromHTML(buildUserBlock(optimistic));
            feedEl.appendChild(node);
            wireCommentNode(node);
            knownIds.add(tempId);
            bumpCommentCount(1);
            scrollToBottom();

            var commentIds = resolveLookupIds();
            return fetch('/api/comment', {
              method: 'POST',
              headers: Object.assign(
                { 'Content-Type': 'application/json' },
                miniappLookupHeaders(),
              ),
              body: JSON.stringify({
                post_id: commentIds.postId || postId,
                chat_id: Number(commentIds.chatId || chatId),
                message_mid: commentIds.messageMid || undefined,
                user_id: Number(userId),
                username: isAdmin ? channelDisplayName() : username,
                text: text,
                photo_urls: urls.length ? urls : undefined,
              }),
            })
              .then(function (r) {
                return parseApiJsonResponse(r).then(function (j) {
                  if (!r.ok) {
                    throw new Error((j && j.error) || String(r.status));
                  }
                  return j;
                });
              })
              .then(function (res) {
                knownIds.delete(tempId);
                knownIds.add(res.comment_id);
                if (optimistic.posted_as_channel) {
                  node.remove();
                  var saved = {
                    comment_id: res.comment_id,
                    user_id: Number(userId),
                    username: res.username || optimistic.username,
                    text: res.text != null ? res.text : text,
                    timestamp: res.timestamp || optimistic.timestamp,
                    photo_urls: res.photo_urls || optimistic.photo_urls,
                  };
                  if (res.posted_as_channel) {
                    saved.posted_as_channel = true;
                    if (res.avatar_url) saved.avatar_url = res.avatar_url;
                  } else if (res.avatar_url || currentUserPhotoUrl) {
                    saved.avatar_url = res.avatar_url || currentUserPhotoUrl;
                  }
                  mergeOrUpdateComment(saved);
                  return;
                }
                node.setAttribute('data-comment-id', res.comment_id);
                var tEl = node.querySelector('.bubble-u .utime');
                if (tEl && res.timestamp) {
                  var tx = parseCommentTimestamp(res.timestamp);
                  tEl.textContent = tx ? formatCommentClock(tx) : String(res.timestamp);
                }
                if (res.timestamp) {
                  var tx2 = parseCommentTimestamp(res.timestamp);
                  if (tx2) node.setAttribute('data-date-key', dateKeyLocal(tx2));
                }
              })
              .catch(function (e) {
                setErr(e, 'Не удалось выполнить действие');
                knownIds.delete(tempId);
                node.remove();
                bumpCommentCount(-1);
                inputEl.value = text;
                resizeComposerInput();
              });
          })
          .catch(function (e) {
            if (e && e.message !== 'pending') {
              setErr(e, 'Не удалось отправить комментарий');
            }
          })
          .finally(function () {
            updateSendEnabled();
            resizeComposerInput();
            scrollToBottom();
          });
      }

      sendBtn.addEventListener('click', submitComment);
      if (photoBtnEl && photoInputEl && !photoBtnEl.dataset.bound) {
        photoBtnEl.dataset.bound = '1';
        photoBtnEl.addEventListener('click', function () {
          photoInputEl.click();
        });
        photoInputEl.addEventListener('change', function () {
          var files = photoInputEl.files ? Array.from(photoInputEl.files) : [];
          photoInputEl.value = '';
          if (!files.length) return;
          var maxAdd = Math.max(0, 10 - pendingPhotoFiles.length);
          files.slice(0, maxAdd).forEach(function (file) {
            if (!file.type || file.type.indexOf('image/') !== 0) return;
            pendingPhotoFiles.push({
              file: file,
              previewUrl: URL.createObjectURL(file),
            });
          });
          renderComposerAttachments();
          updateSendEnabled();
        });
      }
      if (composerAttachmentsEl && !composerAttachmentsEl.dataset.bound) {
        composerAttachmentsEl.dataset.bound = '1';
        composerAttachmentsEl.addEventListener('click', function (e) {
          var rm = e.target.closest('[data-remove-photo]');
          if (rm) {
            var idx = parseInt(rm.getAttribute('data-remove-photo') || '', 10);
            if (!Number.isFinite(idx) || idx < 0 || idx >= pendingPhotoFiles.length) return;
            var removed = pendingPhotoFiles.splice(idx, 1)[0];
            if (removed) {
              try {
                URL.revokeObjectURL(removed.previewUrl);
              } catch (_) {}
            }
            renderComposerAttachments();
            updateSendEnabled();
            return;
          }
          var img = e.target.closest('.composer-attachment img.media-zoomable');
          if (!img) return;
          e.preventDefault();
          e.stopPropagation();
          var urls = pendingPhotoFiles.map(function (item) {
            return item.previewUrl;
          });
          var startIdx = urls.indexOf(photoViewerSrc(img));
          openPhotoViewer(urls, startIdx >= 0 ? startIdx : 0);
        });
      }
      if (replyBannerCloseEl && !replyBannerCloseEl.dataset.bound) {
        replyBannerCloseEl.dataset.bound = '1';
        replyBannerCloseEl.addEventListener('click', function () {
          hideReplyBanner();
        });
      }
      if (postPreviewBtnEl && postPreviewBtnEl.dataset.bound !== '1') {
        postPreviewBtnEl.dataset.bound = '1';
        setPostPreviewReady(false);
        postPreviewBtnEl.addEventListener('click', function () {
          openChannelPost();
        });
      }
      if (postDetailCloseEl && postDetailCloseEl.dataset.bound !== '1') {
        postDetailCloseEl.dataset.bound = '1';
        postDetailCloseEl.addEventListener('click', hidePostDetailOverlay);
      }
      if (postDetailOverlayEl && postDetailOverlayEl.dataset.bound !== '1') {
        postDetailOverlayEl.dataset.bound = '1';
        postDetailOverlayEl.addEventListener('click', function (e) {
          if (e.target === postDetailOverlayEl) hidePostDetailOverlay();
        });
      }
      if (postDetailOpenChannelEl && postDetailOpenChannelEl.dataset.bound !== '1') {
        postDetailOpenChannelEl.dataset.bound = '1';
        postDetailOpenChannelEl.addEventListener('click', function () {
          if (channelPostUrl) {
            openExternalUrl(channelPostUrl);
          } else {
            fetchChannelPostUrl().then(function (url) {
              if (url) openExternalUrl(url);
            });
          }
        });
      }
      inputEl.addEventListener('input', function () {
        resizeComposerInput();
        updateSendEnabled();
      });
      inputEl.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          if (inputEl.value.trim() || pendingPhotoFiles.length > 0) submitComment();
        }
      });

      updateSendEnabled();

      var postLoadPromise = loadPost();
      postLoadPromise.catch(function () {});
      Promise.all([postLoadPromise, refreshAdminStateFromServer()])
        .then(function () {
          return loadComments(true);
        })
        .catch(function () {})
        .then(function () {
        if (chatId && userId) {
          fetch(
            '/api/channel-settings?chat_id=' +
              encodeURIComponent(chatId) +
              '&user_id=' +
              encodeURIComponent(userId || '0')
          )
            .then(function (r) {
              return r.json();
            })
            .then(function (data) {
              if (data.manager_url) {
                var btn = document.getElementById('managerBtn');
                btn.href = data.manager_url;
                btn.style.display = 'inline-flex';
              }
            })
            .catch(function () {});
        }
        });

      setInterval(function () {
        if (postRecoveryUiVisible) return;
        loadComments(false);
      }, 15000);
    }

    showJoinPage();
    bootHome();
    bootComments();

    if (getBridgeNumericUserId(user) == null && (inMax || isLikelyMaxMiniapp() || inTelegram)) {
      var homeUserRetry = 0;
      var homeUserRetryTimer = window.setInterval(function () {
        homeUserRetry += 1;
        var freshBridge = getWebAppBridge();
        tryReadyBridge(freshBridge);
        var freshUser = resolveBridgeUser(freshBridge);
        var freshUid = getBridgeNumericUserId(freshUser);
        if (freshUid != null) {
          window.clearInterval(homeUserRetryTimer);
          user = freshUser;
          mergedParams = buildMergedSearchParams(user, startParam);
          bootHome();
          return;
        }
        if (homeUserRetry >= 50) {
          window.clearInterval(homeUserRetryTimer);
          var homeErrEl = document.getElementById('homeErr');
          if (homeErrEl) {
            homeErrEl.textContent =
              'Не удалось определить профиль. Закройте приложение и откройте снова из бота MAX.';
          }
          syncHomeUserBadge(null);
        }
      }, 200);
    }
    }

    window.addEventListener('error', function (ev) {
      console.error('[miniapp] Uncaught error:', ev.message, 'at', ev.filename + ':' + ev.lineno, ev.error);
    });
    window.addEventListener('unhandledrejection', function (ev) {
      console.error('[miniapp] Unhandled promise rejection:', ev.reason);
    });

    function preflightBackendInBackground() {
      var healthUrl = apiUrl('/health')
      fetchWithTimeout(healthUrl, { cache: 'no-store' }, 6000)
        .then(function (r) {
          if (!r.ok) throw new Error('health ' + r.status)
          return fetchWithTimeout(apiUrl('/api/config'), { cache: 'no-store' }, 6000)
        })
        .then(function (r) {
          if (!r.ok) throw new Error('config ' + r.status)
          return r.json()
        })
        .then(function () {
          hideBootError()
        })
        .catch(function (e) {
          logMiniappError('preflight', e)
          showBootError(
            e,
            'Медленная связь с сервером. Закройте приложение и откройте снова из бота.'
          )
        })
    }

    function startAppWhenReady() {
      var attempts = 0;
      var started = false;
      function launchApp() {
        if (started) return;
        started = true;
        initApp();
        preflightBackendInBackground();
      }
      var preferTg = isMiniappTelegramRuntime();
      var likelyMax = isLikelyMaxMiniapp();
      var postContextHint = hasPostContextInLocation();
      var hardDeadlineMs =
        preferTg && !postContextHint ? 10000 : likelyMax ? 12000 : 3000;
      try {
        var earlySp = new URLSearchParams(location.search);
        var earlyStart = String(earlySp.get('startapp') || earlySp.get('start_param') || '');
        if (
          postContextHint ||
          (!preferTg &&
            !likelyMax &&
            (earlySp.get('post_id') ||
              /post_id|_mid_/i.test(earlyStart) ||
              /^\d+$/.test(String(earlySp.get('user_id') || '').trim())))
        ) {
          hardDeadlineMs = 1500;
        }
      } catch (e) {}
      var hardDeadline = window.setTimeout(launchApp, hardDeadlineMs);

      function run() {
        if (postContextHint || hasPostContextInLocation()) {
          window.clearTimeout(hardDeadline);
          launchApp();
          return;
        }
        attempts += 1;
        var bridge = getWebAppBridge();
        tryReadyBridge(bridge);
        var likelyMaxNow = isLikelyMaxMiniapp();
        var likelyTg = isLikelyTelegramWebView();
        var maxAttempts = likelyMaxNow ? 80 : likelyTg || preferTg ? 30 : 8;
        var user = resolveBridgeUser(bridge);
        var unsafe = (bridge && bridge.initDataUnsafe) || {};
        var sp = collectStartParam(unsafe, bridge);
        var urlSp = new URLSearchParams(location.search);
        var hasUrlUser =
          /^\d+$/.test(String(urlSp.get('user_id') || '').trim()) ||
          /^\d+$/.test(String(urlSp.get('tg_uid') || '').trim());
        var hasBridgeUser = getBridgeNumericUserId(user) != null;
        var needTgScript =
          (likelyTg || preferTg || !likelyMaxNow) &&
          (!bridge || !hasBridgeUser) &&
          (likelyTg ||
            preferTg ||
            urlSp.get('platform') === 'telegram' ||
            /[?&]tg_/i.test(location.search || '') ||
            !!(window.Telegram && window.Telegram.WebApp));
        if (needTgScript && !(window.Telegram && window.Telegram.WebApp)) {
          loadTelegramWebAppScript()
            .catch(function () {})
            .finally(function () {
              window.setTimeout(run, 50);
            });
          return;
        }
        if (
          !sp &&
          !hasUrlUser &&
          !hasBridgeUser &&
          (bridge || preferTg || likelyMaxNow) &&
          attempts < maxAttempts
        ) {
          window.setTimeout(run, 150);
          return;
        }
        if (likelyMaxNow && !hasBridgeUser && !hasUrlUser && attempts >= maxAttempts) {
          window.setTimeout(run, 200);
          return;
        }
        window.clearTimeout(hardDeadline);
        launchApp();
      }

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
          window.setTimeout(run, 0);
        });
      } else {
        window.setTimeout(run, 0);
      }
    }

    startAppWhenReady();
