(function () {
  'use strict';

  var API_BASE = '/api/admin';
  var API_CHANNEL_IMPORT = '/api/channel-import';
  var API_INTEGRATIONS = '/api/integrations';
  var API_FLOWS = '/api/flows';
  var API_INT_ANALYTICS = '/api/integrations-analytics';
  var integrationsTab = 'connections';
  var integrationsCache = [];
  var flowsCache = [];
  var intMaxMeta = null;
  var tgLinkedChatsCache = [];
  var maxLinkedChatsCache = [];
  var maxChannelsRefreshedAt = null;
  var currentRoute = '';
  var dashRefreshTimer = null;
  var dashLoadSeq = 0;
  var logsRefreshTimer = null;
  var dashPeriodDays = 7;
  var channelsCache = [];
  var channelsCacheLight = false;
  var selectedChannelId = null;
  var channelDetailTab = 'stats';
  var channelSettingsEditing = false;
  var channelAntispamEditing = false;
  var commentsChatId = null;
  var commentsQuery = '';
  var commentsStatusFilter = '';
  var usersCache = [];
  var selectedUserId = null;
  var userDetailCache = {};
  var usersFilterQuery = '';
  var usersFilterStatus = 'all';
  var usersFilterStarted = 'all';
  var usersFilterChannel = 'all';
  var channelImportPollTimer = null;
  var channelImportJobId = null;
  var chainsPlatformTab = 'tg';
  var chainsListFilter = 'all';
  var chainsListSearch = '';
  var chainsWizardCollapsed = false;
  var antispamTab = 'overview';
  var antispamLogCache = [];

  var NAV = [
    {
      group: 'Обзор',
      items: [{ id: 'dashboard', label: 'Дашборд', icon: 'layout-dashboard' }],
    },
    {
      group: 'MAX-каналы',
      items: [
        { id: 'channels', label: 'Каналы', icon: 'radio' },
        { id: 'comments', label: 'Комментарии', icon: 'message-square' },
        { id: 'autoposts', label: 'Автопостинг', icon: 'calendar-clock' },
      ],
    },
    {
      group: 'Telegram → MAX',
      items: [
        { id: 'tgchains', label: 'Цепочки', icon: 'link-2' },
        { id: 'channelimport', label: 'Импорт архива', icon: 'upload-cloud' },
        { id: 'integrations', label: 'Интеграции', icon: 'plug' },
      ],
    },
    {
      group: 'Модерация',
      items: [
        { id: 'antispam', label: 'Антиспам', icon: 'shield' },
        { id: 'users', label: 'Пользователи', icon: 'users' },
      ],
    },
    {
      group: 'Система',
      items: [
        { id: 'logs', label: 'Логи', icon: 'terminal' },
        { id: 'ailog', label: 'ИИ-анализ', icon: 'sparkles' },
        { id: 'settings', label: 'Настройки', icon: 'settings' },
      ],
    },
  ];

  var PAGE_META = {
    dashboard: {
      title: 'Дашборд',
      group: 'Обзор',
      desc: 'Сводка по MAX и Telegram: каналы, комментарии, активность и эффективность.',
    },
    channels: {
      title: 'Каналы',
      group: 'MAX-каналы',
      desc: 'Подключённые MAX-каналы, статистика, настройки комментариев и антиспам.',
    },
    comments: {
      title: 'Комментарии',
      group: 'MAX-каналы',
      desc: 'Просмотр и удаление комментариев по каналам.',
    },
    autoposts: {
      title: 'Автопостинг',
      group: 'MAX-каналы',
      desc: 'Планировщик публикаций в Telegram-каналы: расписание, серии, статистика и шаблоны.',
    },
    tgchains: {
      title: 'Цепочки',
      group: 'Telegram → MAX',
      desc: 'Пересылка Telegram → MAX и публикация MAX → VK, синхронизация комментариев.',
    },
    channelimport: {
      title: 'Импорт архива',
      group: 'Telegram → MAX',
      desc: 'Перенос истории канала из Telegram в MAX через MTProto.',
    },
    integrations: {
      title: 'Интеграции',
      group: 'Telegram → MAX',
      desc: 'Токены платформ, списки каналов и простые потоки пересылки.',
    },
    antispam: {
      title: 'Антиспам',
      group: 'Модерация',
      desc: 'Глобальные стоп-слова, правила фильтрации и журнал блокировок.',
    },
    users: {
      title: 'Пользователи',
      group: 'Модерация',
      desc: 'Список пользователей, ограничения, уведомления и история комментариев.',
    },
    logs: {
      title: 'Логи',
      group: 'Система',
      desc: 'Журнал работы бота, статистика БД и ИИ-анализ проблем.',
    },
    ailog: {
      title: 'ИИ-анализ',
      group: 'Система',
      desc: 'Отчёты о проблемах бота простым языком. Настройка оператора — в разделе «Настройки».',
    },
    settings: {
      title: 'Настройки',
      group: 'Система',
      desc: 'Интервал опроса, оператор ИИ для анализа логов и опасные операции.',
    },
  };

  var PAGE_TITLES = {
    dashboard: 'Дашборд',
    channels: 'Каналы',
    tgchains: 'Цепочки',
    channelimport: 'Импорт архива',
    autoposts: 'Автопостинг',
    integrations: 'Интеграции',
    antispam: 'Антиспам',
    comments: 'Комментарии',
    users: 'Пользователи',
    logs: 'Логи',
    ailog: 'ИИ-анализ',
    settings: 'Настройки',
  };

  var ACTIVITY_LABELS = {
    new_subscriber: 'Новый подписчик',
    new_comment: 'Новый комментарий',
    new_post_button: 'Кнопка на посте',
    admin_reply: 'Ответ администратора',
    channel_added: 'Канал подключён',
    channel_removed: 'Канал отключён',
    antispam_block: 'Блокировка антиспама',
  };

  function qs(sel, root) {
    return (root || document).querySelector(sel);
  }

  function qsa(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }

  function esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escTextarea(s) {
    return String(s == null ? '' : s).replace(/<\/textarea/gi, '<\\/textarea');
  }

  function copyTextToClipboard(text, okMessage) {
    var v = String(text || '');
    if (!v) {
      showToast('Нечего копировать', 'info');
      return;
    }
    function onOk() {
      showToast(okMessage || 'Скопировано в буфер обмена', 'success');
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(v).then(onOk).catch(fallbackCopy);
      return;
    }
    fallbackCopy();

    function fallbackCopy() {
      var ta = document.createElement('textarea');
      ta.value = v;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      try {
        if (document.execCommand('copy')) onOk();
        else showToast(v.slice(0, 500), 'info');
      } catch (_e) {
        showToast(v.slice(0, 500), 'info');
      }
      document.body.removeChild(ta);
    }
  }

  function channelInitials(title) {
    var t = String(title || '').trim();
    if (!t) return '?';
    var parts = t.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      return (parts[0].charAt(0) + parts[1].charAt(0)).toUpperCase();
    }
    return t.slice(0, 2).toUpperCase();
  }

  function channelAvatarHtml(url, title, extraClass) {
    var cls = 'channel-avatar' + (extraClass ? ' ' + extraClass : '');
    var avUrl = url && String(url).trim() ? String(url).trim() : '';
    if (avUrl) {
      return (
        '<span class="' +
        esc(cls) +
        ' with-photo"><img src="' +
        esc(avUrl) +
        '" alt="" loading="lazy" /></span>'
      );
    }
    return '<span class="' + esc(cls) + '">' + esc(channelInitials(title)) + '</span>';
  }

  function userInitials(name, userId) {
    var t = String(name || '').trim();
    if (t) {
      var parts = t.split(/\s+/).filter(Boolean);
      if (parts.length >= 2) return (parts[0].charAt(0) + parts[1].charAt(0)).toUpperCase();
      return t.slice(0, 2).toUpperCase();
    }
    var tail = String(userId || '').slice(-2);
    return tail ? ('U' + tail).slice(0, 2).toUpperCase() : 'U';
  }

  function userAvatarHtml(user, extraClass) {
    var cls = 'user-avatar' + (extraClass ? ' ' + extraClass : '');
    var avUrl = user && user.avatar_url ? String(user.avatar_url).trim() : '';
    if (avUrl) {
      return (
        '<span class="' +
        esc(cls) +
        ' with-photo"><img src="' +
        esc(avUrl) +
        '" alt="" loading="lazy" /></span>'
      );
    }
    return '<span class="' + esc(cls) + '">' + esc(userInitials(user && user.name, user && user.user_id)) + '</span>';
  }

  function fmtDateTime(iso) {
    if (!iso) return '—';
    var t = Date.parse(iso);
    if (!Number.isFinite(t)) return String(iso);
    return new Date(t).toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function truncateText(text, maxLen) {
    var s = String(text || '').trim();
    if (!s) return '';
    if (s.length <= maxLen) return s;
    return s.slice(0, maxLen - 1) + '…';
  }

  function boolLabel(on) {
    return on ? 'Включено' : 'Выключено';
  }

  function renderRecentComments(comments) {
    if (!comments || !comments.length) {
      return '<p class="muted">Нет комментариев</p>';
    }
    var html = '<div class="recent-comments">';
    comments.forEach(function (c) {
      var answered = c.reply_status === 'answered' || (c.reply && c.reply.text);
      var post = c.post_context || {};
      var postText = truncateText(post.text || 'Пост без текста', 140);
      var postAuthor = post.sender_name ? String(post.sender_name).trim() : '';
      html += '<article class="comment-card">';
      html += '<div class="comment-card-head">';
      html += '<div class="comment-card-user"><strong>' + esc(c.username || 'Пользователь') + '</strong>';
      if (c.source === 'telegram') {
        html += '<span class="comment-source-tag">TG</span>';
      }
      html += '<span class="comment-card-time">' + esc(formatRelativeTime(c.timestamp)) + '</span></div>';
      html +=
        '<span class="comment-status ' +
        (answered ? 'answered' : 'pending') +
        '">' +
        esc(answered ? 'Отвечено' : 'Без ответа') +
        '</span>';
      html += '</div>';
      html += '<div class="comment-card-text">' + esc(c.text || '') + '</div>';
      var postUrl =
        post.channel_post_url && String(post.channel_post_url).trim()
          ? String(post.channel_post_url).trim()
          : '';
      html += postUrl
        ? '<a class="comment-post-context" href="' +
          esc(postUrl) +
          '" target="_blank" rel="noopener noreferrer" title="Открыть пост в MAX">'
        : '<div class="comment-post-context">';
      html += '<span class="comment-post-label">К посту</span>';
      if (post.photo_url) {
        html +=
          '<img class="comment-post-thumb" src="' +
          esc(post.photo_url) +
          '" alt="" loading="lazy" />';
      }
      html += '<div class="comment-post-body">';
      if (postAuthor) {
        html += '<div class="comment-post-author">' + esc(postAuthor) + '</div>';
      }
      html += '<div class="comment-post-text">' + esc(postText) + '</div>';
      if (post.timestamp) {
        html +=
          '<span class="comment-post-time">' +
          esc(formatRelativeTime(post.timestamp)) +
          '</span>';
      }
      html += '</div>' + (postUrl ? '</a>' : '</div>');
      if (answered && c.reply) {
        var adminName = c.reply.admin_name ? String(c.reply.admin_name).trim() : '';
        html += '<div class="comment-reply-block">';
        html += '<div class="comment-reply-label">Ответ администратора';
        if (adminName) html += ' · ' + esc(adminName);
        html += '</div>';
        html += '<div class="comment-reply-text">' + esc(c.reply.text || '') + '</div>';
        html +=
          '<span class="comment-reply-time">' +
          esc(formatRelativeTime(c.reply.timestamp)) +
          '</span>';
        html += '</div>';
      }
      html += '</article>';
    });
    html += '</div>';
    return html;
  }

  function settingsSummaryRow(label, value) {
    return (
      '<div class="settings-summary-row"><dt>' +
      esc(label) +
      '</dt><dd>' +
      esc(value) +
      '</dd></div>'
    );
  }

  function renderChannelSettingsPanel(settings, editing) {
    if (!editing) {
      var html = '<div class="settings-summary">';
      html += '<h3 class="settings-summary-title">Текущие настройки</h3>';
      html += '<dl class="settings-summary-list">';
      html += settingsSummaryRow(
        'Текст кнопки',
        settings.button_text && String(settings.button_text).trim()
          ? String(settings.button_text).trim()
          : '—',
      );
      html += settingsSummaryRow(
        'Приветствие',
        settings.welcome_message && String(settings.welcome_message).trim()
          ? truncateText(settings.welcome_message, 200)
          : '—',
      );
      html += settingsSummaryRow('Уведомлять админа', boolLabel(!!settings.notify_admin));
      html += settingsSummaryRow('Показывать реакции', boolLabel(!!settings.show_reactions));
      html += settingsSummaryRow('Режим модерации', boolLabel(!!settings.moderation_mode));
      html += '</dl>';
      html +=
        '<button type="button" class="btn btn-primary mt-sm" id="btnEditChannelSettings">Изменить</button>';
      html += '</div>';
      return html;
    }
    var form =
      '<div class="settings-editor"><p class="muted text-sm mb-sm">Подтвердите сохранение — изменения применятся к каналу.</p>';
    form += '<div id="chSettingsForm">';
    form += '<div class="form-group"><label>Текст кнопки</label>';
    form +=
      '<input class="input" id="f_btn_text" value="' + esc(settings.button_text || '') + '"/></div>';
    form += '<div class="form-group"><label>Приветствие</label>';
    form +=
      '<textarea class="textarea" id="f_welcome">' +
      esc(settings.welcome_message || '') +
      '</textarea></div>';
    form += '<div id="setToggles">';
    form += toggleRow('notify_admin', 'Уведомлять админа', 'О новых комментариях', !!settings.notify_admin);
    form += toggleRow('show_reactions', 'Показывать реакции', '', !!settings.show_reactions);
    form += toggleRow('moderation_mode', 'Режим модерации', '', !!settings.moderation_mode);
    form += '</div>';
    form += '<div class="flex gap-sm mt-sm">';
    form +=
      '<button type="button" class="btn btn-ghost" id="btnCancelChannelSettings">Отмена</button>';
    form +=
      '<button type="button" class="btn btn-primary" id="btnSaveChannel">Сохранить</button>';
    form += '</div></div></div>';
    return form;
  }

  function renderChannelAntispamPanel(settings, editing) {
    var words = Array.isArray(settings.stopwords) ? settings.stopwords : [];
    var html = '<div class="as-channel-panel">';
    html +=
      '<div class="as-hint-box"><i data-lucide="info"></i><div><strong>Наследование правил</strong><p>Глобальные фильтры из раздела «Антиспам» действуют на все каналы. Здесь можно добавить стоп-слова и переопределить отдельные правила только для этого канала.</p></div></div>';
    if (!editing) {
      html += '<div class="as-channel-rules">';
      html += '<div class="as-rule-pill' + (settings.block_links ? ' on' : '') + '"><i data-lucide="link-2"></i> Ссылки: ' + esc(boolLabel(!!settings.block_links)) + '</div>';
      html += '<div class="as-rule-pill' + (settings.flood_protection ? ' on' : '') + '"><i data-lucide="timer"></i> Антифлуд: ' + esc(boolLabel(!!settings.flood_protection)) + '</div>';
      html += '<div class="as-rule-pill' + (settings.auto_mute ? ' on' : '') + '"><i data-lucide="volume-x"></i> Авто-мут: ' + esc(boolLabel(!!settings.auto_mute)) + '</div>';
      html += '</div>';
      html += '<div class="settings-summary mt-sm">';
      html += '<h3 class="settings-summary-title">Стоп-слова канала</h3>';
      if (words.length) {
        html += '<div class="as-word-chips">';
        words.forEach(function (w) {
          html += '<span class="as-word-chip">' + esc(w) + '</span>';
        });
        html += '</div>';
      } else {
        html += '<p class="muted text-sm" style="margin:0">Дополнительных стоп-слов нет — используются только глобальные.</p>';
      }
      html += '</div>';
      html +=
        '<button type="button" class="btn btn-primary mt-sm" id="btnEditChannelAntispam">Настроить для канала</button>';
      html += '</div>';
      return html;
    }
    html += '<div class="settings-editor" id="chAntispamForm">';
    html += '<div class="form-group"><label>Дополнительные стоп-слова</label>';
    html += '<p class="field-hint">Добавляются к глобальному списку. Одно слово или фраза — Enter.</p>';
    html += '<div class="tags-input-wrap" id="chStopwords"></div></div>';
    html += '<h4 class="as-section-label">Правила канала</h4>';
    html += '<div class="as-rule-cards" id="asToggles">';
    html += antispamRuleCard('block_links', 'Блокировать ссылки', 'Удалять комментарии с URL и t.me-ссылками', !!settings.block_links);
    html += antispamRuleCard('flood_protection', 'Антифлуд', 'Ограничивать слишком частые комментарии от одного пользователя', !!settings.flood_protection);
    html += antispamRuleCard('auto_mute', 'Авто-мут при бане', 'Автоматически ограничивать пользователя при срабатывании бана', !!settings.auto_mute);
    html += '</div>';
    html += '<div class="flex gap-sm mt-md">';
    html +=
      '<button type="button" class="btn btn-ghost" id="btnCancelChannelAntispam">Отмена</button>';
    html +=
      '<button type="button" class="btn btn-primary" id="btnSaveAntispamCh">Сохранить</button>';
    html += '</div></div></div>';
    return html;
  }

  function apiPath(path) {
    return API_BASE + (path.charAt(0) === '/' ? path : '/' + path);
  }

  function handleAuth(res) {
    if (res.status === 403 || res.status === 401) {
      window.location.href = '/admin/login';
      throw new Error('auth');
    }
    return res;
  }

  function authFetch(url, opts) {
    opts = opts || {};
    opts.credentials = 'same-origin';
    if (!opts.headers) opts.headers = {};
    var timeoutMs =
      typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
        ? opts.timeoutMs
        : 0;
    delete opts.timeoutMs;
    if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    if (typeof AbortController === 'function' && timeoutMs > 0) {
      var controller = new AbortController();
      opts.signal = controller.signal;
      var timer = window.setTimeout(function () {
        controller.abort();
      }, timeoutMs);
      return fetch(url, opts)
        .then(handleAuth)
        .finally(function () {
          window.clearTimeout(timer);
        });
    }
    return fetch(url, opts).then(handleAuth);
  }

  function parseApiJsonResponse(r) {
    var ct = (r.headers.get('content-type') || '').toLowerCase();
    return r.text().then(function (text) {
      var trimmed = (text || '').trim();
      if (trimmed.charAt(0) === '<' || ct.indexOf('text/html') !== -1) {
        throw new Error(
          'Сервер вернул HTML вместо JSON (HTTP ' +
            r.status +
            '). Проверьте nginx и выполните: git pull && docker compose up -d --build',
        );
      }
      if (!trimmed) return {};
      try {
        return JSON.parse(trimmed);
      } catch (e) {
        throw new Error('Ответ API не JSON (HTTP ' + r.status + ')');
      }
    });
  }

  function getJson(path) {
    return authFetch(apiPath(path)).then(function (r) {
      return parseApiJsonResponse(r).then(function (j) {
        if (!r.ok) throw new Error((j && j.error) || 'HTTP ' + r.status);
        return j;
      });
    });
  }

  function postJson(path, body) {
    var timeoutMs = 20000;
    if (path === '/refresh-buttons') timeoutMs = 60000;
    if (path === '/logs/analyze') timeoutMs = 120000;
    if (path === '/logs/ai-test') timeoutMs = 60000;
    return authFetch(apiPath(path), {
      method: 'POST',
      body: body || {},
      timeoutMs: timeoutMs,
    }).then(function (r) {
      return parseApiJsonResponse(r).then(function (j) {
        if (!r.ok) {
          throw new Error((j && j.error) || (j && j.message) || 'Ошибка');
        }
        return j;
      });
    });
  }

  function postForm(path, formData) {
    return authFetch(apiPath(path), { method: 'POST', body: formData }).then(function (r) {
      if (!r.ok) {
        return r.json().then(function (j) {
          throw new Error(j.error || j.message || 'Ошибка');
        });
      }
      return r.json();
    });
  }

  function patchJson(path, body) {
    return authFetch(apiPath(path), { method: 'PATCH', body: body || {} }).then(function (r) {
      return parseApiJsonResponse(r).then(function (j) {
        if (!r.ok) throw new Error((j && j.error) || (j && j.message) || 'Ошибка');
        return j;
      });
    });
  }

  function deleteReq(path) {
    return authFetch(apiPath(path), { method: 'DELETE' }).then(function (r) {
      return parseApiJsonResponse(r).then(function (j) {
        if (!r.ok) throw new Error((j && j.error) || (j && j.message) || 'Ошибка');
        return j;
      });
    });
  }

  function putJsonAbs(url, body) {
    return authFetch(url, { method: 'PUT', body: body || {} }).then(function (r) {
      return parseApiJsonResponse(r).then(function (j) {
        if (!r.ok) throw new Error((j && j.error) || (j && j.message) || 'Ошибка');
        return j;
      });
    });
  }

  function getJsonAbs(url) {
    return authFetch(url).then(function (r) {
      return parseApiJsonResponse(r).then(function (j) {
        if (!r.ok) throw new Error((j && j.error) || 'HTTP ' + r.status);
        return j;
      });
    });
  }

  function postJsonAbs(url, body) {
    return authFetch(url, { method: 'POST', body: body || {} }).then(function (r) {
      return parseApiJsonResponse(r).then(function (j) {
        if (!r.ok) throw new Error((j && j.error) || (j && j.message) || 'Ошибка');
        return j;
      });
    });
  }

  function deleteAbs(url) {
    return authFetch(url, { method: 'DELETE' }).then(function (r) {
      return parseApiJsonResponse(r).then(function (j) {
        if (!r.ok) throw new Error((j && j.error) || (j && j.message) || 'Ошибка');
        return j;
      });
    });
  }

  function patchJsonAbs(url, body) {
    return authFetch(url, { method: 'PATCH', body: body || {} }).then(function (r) {
      return parseApiJsonResponse(r).then(function (j) {
        if (!r.ok) throw new Error((j && j.error) || (j && j.message) || 'Ошибка');
        return j;
      });
    });
  }

  function ensureIntegrationsCache() {
    if (integrationsCache.length) {
      return Promise.resolve(integrationsCache);
    }
    return getJsonAbs(API_INTEGRATIONS)
      .then(function (data) {
        integrationsCache = data.integrations || [];
        var tgRec = integrationsCache.find(function (i) {
          return i.platform === 'telegram' && i.status === 'connected';
        });
        if (tgRec && tgRec.linkedChats && tgRec.linkedChats.length) {
          tgLinkedChatsCache = tgRec.linkedChats;
        }
        return integrationsCache;
      })
      .catch(function () {
        return integrationsCache;
      });
  }

  function renderChainsPlatformTabs(active, counts) {
    counts = counts || {};
    var tgCount = counts.tg != null ? counts.tg : 0;
    var vkCount = counts.vk != null ? counts.vk : 0;
    return (
      '<div class="chains-platform-tabs" role="tablist">' +
      '<button type="button" role="tab" class="chains-platform-tab' +
      (active === 'tg' ? ' active' : '') +
      '" data-chains-tab="tg" aria-selected="' +
      (active === 'tg' ? 'true' : 'false') +
      '"><i data-lucide="send"></i> Telegram → MAX<span class="chains-tab-count">' +
      esc(String(tgCount)) +
      '</span></button>' +
      '<button type="button" role="tab" class="chains-platform-tab' +
      (active === 'vk' ? ' active' : '') +
      '" data-chains-tab="vk" aria-selected="' +
      (active === 'vk' ? 'true' : 'false') +
      '"><i data-lucide="share-2"></i> MAX → VK<span class="chains-tab-count">' +
      esc(String(vkCount)) +
      '</span></button>' +
      '</div>'
    );
  }

  function renderChainsPageHead(platform, stats) {
    var st = stats || {};
    var isTg = platform === 'tg';
    var title = isTg ? 'Пересылка Telegram → MAX' : 'Публикация MAX → VK';
    var desc = isTg
      ? 'Автоматическая публикация постов из Telegram в MAX с опциональной синхронизацией комментариев.'
      : 'Дублирование постов из MAX на стену VK и синхронизация комментариев.';
    var errNum = Number(st.errors_today) || 0;
    var html = '<header class="chains-page-head">';
    html += '<div class="chains-page-head-text"><h2>' + esc(title) + '</h2><p>' + esc(desc) + '</p></div>';
    html += '<div class="chains-inline-stats">';
    html +=
      '<span class="chains-stat-pill"><i data-lucide="link"></i> Активных: <strong>' +
      esc(fmtNum(st.active)) +
      '</strong></span>';
    html +=
      '<span class="chains-stat-pill"><i data-lucide="arrow-right-left"></i> Сегодня: <strong>' +
      esc(fmtNum(st.forwarded_today)) +
      '</strong></span>';
    if (errNum > 0) {
      html +=
        '<span class="chains-stat-pill is-warn"><i data-lucide="alert-circle"></i> Ошибок: <strong>' +
        esc(fmtNum(errNum)) +
        '</strong></span>';
    }
    html += '</div></header>';
    return html;
  }

  function renderChainsToolbar(filteredCount, totalCount) {
    var html = '<div class="chains-toolbar">';
    html += '<div class="chains-search-wrap"><i data-lucide="search"></i>';
    html +=
      '<input type="search" class="chains-search-input" id="chains_search" placeholder="Поиск по каналу…" value="' +
      esc(chainsListSearch) +
      '" autocomplete="off" /></div>';
    html += '<div class="chains-filter-chips" role="group" aria-label="Фильтр">';
    ['all', 'active', 'paused'].forEach(function (f) {
      var labels = { all: 'Все', active: 'Активные', paused: 'На паузе' };
      html +=
        '<button type="button" class="chains-filter-chip' +
        (chainsListFilter === f ? ' active' : '') +
        '" data-chains-filter="' +
        f +
        '">' +
        esc(labels[f]) +
        '</button>';
    });
    html += '</div></div>';
    if (totalCount > 0) {
      html +=
        '<div class="chains-list-meta">Показано ' +
        esc(String(filteredCount)) +
        ' из ' +
        esc(String(totalCount)) +
        '</div>';
    }
    return html;
  }

  function renderChainsEmptyState(platform, hasFilter) {
    var isTg = platform === 'tg';
    var html = '<div class="chains-empty">';
    html += '<div class="chains-empty-icon"><i data-lucide="' + (hasFilter ? 'search-x' : 'link-2') + '"></i></div>';
    if (hasFilter) {
      html += '<p class="chains-empty-title">Ничего не найдено</p>';
      html += '<p class="chains-empty-hint">Измените поиск или сбросьте фильтр</p>';
    } else {
      html +=
        '<p class="chains-empty-title">' +
        (isTg ? 'Пока нет цепочек' : 'Пока нет связок') +
        '</p>';
      html +=
        '<p class="chains-empty-hint">' +
        (isTg
          ? 'Настройте пару каналов слева и нажмите «Включить пересылку»'
          : 'Укажите канал MAX и сообщество VK слева') +
        '</p>';
    }
    html += '</div>';
    return html;
  }

  function chainMatchesSearch(chain, search, platform) {
    if (!search) return true;
    var q = search.toLowerCase();
    if (platform === 'vk') {
      var mx = tgChainMaxDisplayName(chain);
      var parts = [mx.title, mx.sub, chain.vk_group_id, chain.id];
      return parts.some(function (p) {
        return p && String(p).toLowerCase().indexOf(q) !== -1;
      });
    }
    var tg = tgChainTgDisplayName(chain);
    var mx2 = tgChainMaxDisplayName(chain);
    var parts2 = [tg.title, tg.sub, mx2.title, mx2.sub, chain.tg_username, chain.tg_channel_id, chain.id];
    return parts2.some(function (p) {
      return p && String(p).toLowerCase().indexOf(q) !== -1;
    });
  }

  function filterChainsList(chains, platform) {
    return (chains || []).filter(function (c) {
      if (chainsListFilter === 'active' && !c.active) return false;
      if (chainsListFilter === 'paused' && c.active) return false;
      return chainMatchesSearch(c, chainsListSearch, platform);
    });
  }

  function bindChainsListToolbar(main, platform, chains) {
    var searchInp = qs('#chains_search', main);
    if (searchInp && searchInp.getAttribute('data-bound') !== '1') {
      var debounceTimer;
      searchInp.addEventListener('input', function () {
        chainsListSearch = String(searchInp.value || '');
        window.clearTimeout(debounceTimer);
        debounceTimer = window.setTimeout(function () {
          renderTgChains();
        }, 220);
      });
      searchInp.setAttribute('data-bound', '1');
    }
    qsa('[data-chains-filter]', main).forEach(function (btn) {
      if (btn.getAttribute('data-bound') === '1') return;
      btn.addEventListener('click', function () {
        chainsListFilter = btn.getAttribute('data-chains-filter') || 'all';
        renderTgChains();
      });
      btn.setAttribute('data-bound', '1');
    });
    var wizardToggle = qs('[data-chains-wizard-toggle]', main);
    var wizardPanel = qs('[data-chains-wizard-panel]', main);
    if (wizardToggle && wizardPanel && wizardToggle.getAttribute('data-bound') !== '1') {
      wizardToggle.addEventListener('click', function () {
        chainsWizardCollapsed = !chainsWizardCollapsed;
        wizardPanel.classList.toggle('is-collapsed', chainsWizardCollapsed);
        wizardToggle.setAttribute('aria-expanded', chainsWizardCollapsed ? 'false' : 'true');
        refreshIcons();
      });
      wizardToggle.setAttribute('data-bound', '1');
    }
  }

  function renderChainsWizardPanelHead(title, icon) {
    var collapsed = chainsWizardCollapsed ? ' is-collapsed' : '';
    var html =
      '<section class="chains-panel chains-panel--wizard' +
      collapsed +
      '" data-chains-wizard-panel>';
    html += '<div class="chains-panel-head">';
    html += '<h3><i data-lucide="' + esc(icon) + '"></i> ' + esc(title) + '</h3>';
    html +=
      '<button type="button" class="chains-wizard-toggle" data-chains-wizard-toggle aria-expanded="' +
      (chainsWizardCollapsed ? 'false' : 'true') +
      '" aria-label="Свернуть панель"><i data-lucide="chevron-down"></i></button>';
    html += '</div><div class="chains-panel-body">';
    return html;
  }

  function renderChainsRequirementsTg() {
    return (
      '<div class="chains-requirements"><strong>Перед запуском</strong><ul>' +
      '<li>Бот Telegram — админ в <em>исходном</em> канале</li>' +
      '<li>Бот MAX — админ в <em>целевом</em> канале</li>' +
      '<li>У TG-бота нет webhook (иначе перехват не работает)</li>' +
      '</ul></div>'
    );
  }

  function updateChainsWizardSteps(root) {
    var tgRaw = readTelegramChannelPick('tc_tg_select', 'tc_tg_manual', root);
    var maxId = qs('#tc_max', root) ? qs('#tc_max', root).value : '';
    var step1 = qs('[data-wizard-step="1"]', root);
    var step2 = qs('[data-wizard-step="2"]', root);
    if (step1) step1.classList.toggle('is-done', !!tgRaw);
    if (step2) step2.classList.toggle('is-done', !!maxId);
  }

  function bindChainsPlatformTabs(root) {
    qsa('[data-chains-tab]', root).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var next = btn.getAttribute('data-chains-tab') || 'tg';
        if (next === chainsPlatformTab) return;
        chainsPlatformTab = next;
        chainsListFilter = 'all';
        chainsListSearch = '';
        renderTgChains();
      });
    });
  }

  function renderTelegramConnectBanner() {
    var tgInt = integrationsCache.find(function (i) {
      return i.platform === 'telegram' && i.status === 'connected';
    });
    if (tgInt) return '';
    return (
      '<div class="chains-connect-banner">' +
      '<span>Telegram-бот не подключён — списки каналов могут быть пустыми.</span>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-route-jump="integrations">Подключить в «Интеграции»</button>' +
      '</div>'
    );
  }

  function bindRouteJumpButtons(root) {
    qsa('[data-route-jump]', root).forEach(function (btn) {
      btn.addEventListener('click', function () {
        navigate(btn.getAttribute('data-route-jump') || 'integrations');
      });
    });
  }

  function fmtRelativeTime(iso) {
    if (!iso) return '—';
    var t = new Date(iso).getTime();
    if (!t) return '—';
    var diff = Date.now() - t;
    var min = Math.floor(diff / 60000);
    if (min < 1) return 'только что';
    if (min < 60) return min + ' мин назад';
    var h = Math.floor(min / 60);
    if (h < 24) return h + ' ч назад';
    var d = Math.floor(h / 24);
    return d + ' дн назад';
  }

  function platformIconClass(p) {
    if (p === 'telegram') return 'telegram';
    if (p === 'vk') return 'vk';
    return 'max';
  }

  function platformLabel(p) {
    if (p === 'telegram') return 'Telegram';
    if (p === 'vk') return 'ВКонтакте';
    return 'MAX';
  }

  function telegramChatTypeLabel(type) {
    if (type === 'channel') return 'канал';
    if (type === 'supergroup') return 'супергруппа';
    if (type === 'group') return 'группа';
    if (type === 'private') return 'личный чат';
    return 'чат';
  }

  function fetchTelegramLinkedChats(refresh) {
    var q = refresh ? '?refresh=1' : '';
    return getJsonAbs(API_INTEGRATIONS + '/telegram/linked-chats' + q).then(function (data) {
      tgLinkedChatsCache = data.channels || [];
      if (data.integrationId) {
        var tg = integrationsCache.find(function (i) {
          return i.id === data.integrationId;
        });
        if (tg) {
          tg.linkedChats = data.channels || [];
          if (data.linkedChatsUpdatedAt) {
            tg.linkedChatsUpdatedAt = data.linkedChatsUpdatedAt;
          }
        }
      }
      return data;
    });
  }

  function integrationHasToken(record) {
    if (!record) return false;
    if (record.hasToken === true) return true;
    if (record.token && String(record.token).trim()) return true;
    if (record.tokenPreview && String(record.tokenPreview).replace(/[•\s]/g, '').length > 0) {
      return true;
    }
    return false;
  }

  function integrationTokenPreview(record) {
    if (!record) return '';
    if (record.token && String(record.token).trim()) {
      var t = String(record.token);
      return t.length <= 8 ? '••••' : '••••••••' + t.slice(-4);
    }
    return record.tokenPreview ? String(record.tokenPreview) : '';
  }

  function telegramChannelPickValue(ch) {
    return ch.id || ch.username || '';
  }

  function telegramChannelPickValuesEqual(a, b) {
    if (!a || !b) return false;
    return String(a).replace(/^@/, '') === String(b).replace(/^@/, '');
  }

  function renderTelegramChatItemHtml(ch, opts) {
    opts = opts || {};
    var pick = telegramChannelPickValue(ch);
    var meta =
      telegramChatTypeLabel(ch.type) +
      (ch.botIsAdmin ? ' · админ' : ' · не админ') +
      ' · ID ' +
      ch.id;
    var html =
      '<li class="tg-chat-item' +
      (ch.botIsAdmin ? ' tg-chat-item--admin' : '') +
      '"><div class="tg-chat-main"><strong>' +
      esc(ch.title) +
      '</strong>';
    if (ch.username) {
      html += ' <span class="mono text-sm">' + esc(ch.username) + '</span>';
    }
    html += '</div><div class="tg-chat-meta muted">' + esc(meta) + '</div>';
    var admins = Array.isArray(ch.admins) ? ch.admins : [];
    if (admins.length) {
      var started = admins.filter(function (a) {
        return a.started_bot === true;
      }).length;
      html +=
        '<div class="tg-chat-meta" style="margin-top:6px"><strong>Администраторы:</strong> ' +
        started +
        '/' +
        admins.length +
        ' запустили бота</div>';
      html += '<ul class="tg-chat-admin-list" style="margin:6px 0 0 16px;padding:0">';
      admins.forEach(function (a) {
        var role = a.is_creator ? 'владелец' : 'админ';
        var startedMark = a.started_bot ? '✅' : '⚠️';
        var uname = a.username ? ' ' + String(a.username) : '';
        html +=
          '<li class="tg-chat-meta" style="list-style:disc">' +
          startedMark +
          ' ' +
          esc(a.name || String(a.user_id)) +
          (uname ? ' <span class="mono text-sm">' + esc(uname) + '</span>' : '') +
          ' <span class="muted">(' +
          esc(role) +
          ')</span>' +
          '</li>';
      });
      html += '</ul>';
    } else {
      html +=
        '<div class="tg-chat-meta muted" style="margin-top:6px">Администраторы канала недоступны</div>';
    }
    if (opts.copyable !== false) {
      html +=
        '<button type="button" class="btn btn-ghost btn-sm" data-copy-tg-channel="' +
        esc(pick) +
        '">Копировать</button>';
    }
    html += '</li>';
    return html;
  }

  function renderTelegramChatsListHtml(chats, opts) {
    opts = opts || {};
    if (!chats || !chats.length) {
      return (
        '<div class="tg-chats-empty muted">' +
        esc(
          opts.emptyText ||
            'Чаты не найдены. Добавьте бота администратором в канал/группу, отправьте сообщение и нажмите «Загрузить».',
        ) +
        '</div>'
      );
    }
    var adminChats = chats.filter(function (ch) {
      return ch.botIsAdmin === true;
    });
    var otherChats = chats.filter(function (ch) {
      return ch.botIsAdmin !== true;
    });
    var html = '';
    if (adminChats.length) {
      html +=
        '<div class="tg-chats-section-label muted text-sm">Где бот администратор (' +
        adminChats.length +
        ')</div><ul class="tg-chats-list">';
      adminChats.forEach(function (ch) {
        html += renderTelegramChatItemHtml(ch, opts);
      });
      html += '</ul>';
    }
    if (otherChats.length) {
      html +=
        '<div class="tg-chats-section-label muted text-sm" style="margin-top:10px">Прочие чаты (' +
        otherChats.length +
        ')</div><ul class="tg-chats-list">';
      otherChats.forEach(function (ch) {
        html += renderTelegramChatItemHtml(ch, opts);
      });
      html += '</ul>';
    }
    return html;
  }

  function mountTelegramChatsPanel(panel, integrationId, chats) {
    if (!panel) return;
    var list = chats || [];
    var updatedAt = '';
    var tg = integrationsCache.find(function (i) {
      return i.id === integrationId;
    });
    if (tg && tg.linkedChatsUpdatedAt) {
      updatedAt = 'Обновлено: ' + fmtRelativeTime(tg.linkedChatsUpdatedAt);
    }
    var adminCount = list.filter(function (c) {
      return c.botIsAdmin === true;
    }).length;
    panel.innerHTML =
      '<div class="tg-chats-panel-head flex-between">' +
      '<div class="tg-chats-panel-summary">' +
      '<span class="int-channel-stat"><strong>' +
      esc(String(list.length)) +
      '</strong> чатов</span>' +
      '<span class="int-channel-stat is-ok"><strong>' +
      esc(String(adminCount)) +
      '</strong> с правами админа</span>' +
      (updatedAt ? '<span class="muted text-sm">' + esc(updatedAt) + '</span>' : '') +
      '</div>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-refresh-tg-chats="' +
      esc(integrationId) +
      '"><i data-lucide="refresh-cw"></i> Обновить</button></div>' +
      '<p class="int-channels-hint muted text-sm">Каналы, где бот — администратор, доступны в цепочках, потоках и автопостинге.</p>' +
      renderTelegramChatsListHtml(list);
  }

  function fetchMaxLinkedChannels(refresh) {
    var q = refresh ? '?refresh=1' : '';
    return getJsonAbs(API_INTEGRATIONS + '/max/linked-channels' + q).then(function (data) {
      maxLinkedChatsCache = data.channels || [];
      maxChannelsRefreshedAt = data.refreshedAt || null;
      intMaxMeta = {
        channelCount: data.channelCount != null ? data.channelCount : maxLinkedChatsCache.length,
        tokenPreview: data.tokenPreview || (intMaxMeta && intMaxMeta.tokenPreview) || '',
        channels: maxLinkedChatsCache,
        adminCount: data.adminCount,
      };
      return data;
    });
  }

  function maxChannelAccessLabel(access) {
    if (access === 'ok') return 'админ';
    if (access === 'bot_not_admin') return 'не админ';
    if (access === 'bot_not_in_chat') return 'бот не в канале';
    return 'недоступен';
  }

  function renderMaxChatsListHtml(chats) {
    if (!chats || !chats.length) {
      return (
        '<div class="tg-chats-empty muted">' +
        'Каналы не найдены. Добавьте бота администратором в MAX-канал — после подключения нажмите «Загрузить».' +
        '</div>'
      );
    }
    var adminChats = chats.filter(function (ch) {
      return ch.botIsAdmin === true;
    });
    var otherChats = chats.filter(function (ch) {
      return ch.botIsAdmin !== true;
    });
    var html = '';
    function itemHtml(ch) {
      var meta =
        (ch.type === 'channel' ? 'канал' : ch.type || 'чат') +
        ' · ' +
        maxChannelAccessLabel(ch.access) +
        ' · ID ' +
        ch.id;
      var html =
        '<li class="tg-chat-item' +
        (ch.botIsAdmin ? ' tg-chat-item--admin' : '') +
        '"><div class="tg-chat-main"><strong>' +
        esc(ch.title) +
        '</strong></div><div class="tg-chat-meta muted">' +
        esc(meta) +
        '</div>';
      var admins = Array.isArray(ch.admins) ? ch.admins : [];
      if (admins.length) {
        html += '<div class="tg-chat-meta" style="margin-top:6px"><strong>Администраторы:</strong></div>';
        html += '<ul class="tg-chat-admin-list" style="margin:6px 0 0 16px;padding:0">';
        admins.forEach(function (a) {
          html +=
            '<li class="tg-chat-meta" style="list-style:disc">👤 ' +
            esc(a.name || String(a.user_id)) +
            ' <span class="muted">(' +
            esc(a.is_owner ? 'владелец' : 'админ') +
            ')</span></li>';
        });
        html += '</ul>';
      }
      html +=
        '<button type="button" class="btn btn-ghost btn-sm" data-copy-max-channel="' +
        esc(ch.id) +
        '">Копировать ID</button></li>';
      return html;
    }
    if (adminChats.length) {
      html +=
        '<div class="tg-chats-section-label muted text-sm">Где бот администратор (' +
        adminChats.length +
        ')</div><ul class="tg-chats-list">';
      adminChats.forEach(function (ch) {
        html += itemHtml(ch);
      });
      html += '</ul>';
    }
    if (otherChats.length) {
      html +=
        '<div class="tg-chats-section-label muted text-sm" style="margin-top:10px">Прочие (' +
        otherChats.length +
        ')</div><ul class="tg-chats-list">';
      otherChats.forEach(function (ch) {
        html += itemHtml(ch);
      });
      html += '</ul>';
    }
    return html;
  }

  function mountMaxChatsPanel(panel, chats) {
    if (!panel) return;
    panel.removeAttribute('data-max-bound');
    var list = chats || [];
    var updatedAt = maxChannelsRefreshedAt
      ? 'Обновлено: ' + fmtRelativeTime(maxChannelsRefreshedAt)
      : '';
    var adminCount = list.filter(function (c) {
      return c.botIsAdmin === true;
    }).length;
    panel.innerHTML =
      '<div class="tg-chats-panel-head flex-between">' +
      '<div class="tg-chats-panel-summary">' +
      '<span class="int-channel-stat"><strong>' +
      esc(String(list.length)) +
      '</strong> каналов</span>' +
      '<span class="int-channel-stat is-ok"><strong>' +
      esc(String(adminCount)) +
      '</strong> с правами админа</span>' +
      (updatedAt ? '<span class="muted text-sm">' + esc(updatedAt) + '</span>' : '') +
      '</div>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-refresh-max-chats="1"><i data-lucide="refresh-cw"></i> Обновить</button></div>' +
      '<p class="int-channels-hint muted text-sm">Добавьте бота администратором в MAX-канал, затем обновите список.</p>' +
      renderMaxChatsListHtml(list);
  }

  function bindMaxChatsPanel(panel) {
    if (!panel || panel.getAttribute('data-max-bound') === '1') return;
    panel.setAttribute('data-max-bound', '1');
    qsa('[data-copy-max-channel]', panel).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var v = btn.getAttribute('data-copy-max-channel') || '';
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(v).then(function () {
            showToast('Скопировано: ' + v, 'success');
          });
        } else {
          showToast(v, 'info');
        }
      });
    });
    qsa('[data-refresh-max-chats]', panel).forEach(function (ref) {
      ref.addEventListener('click', function () {
        qsa('[data-refresh-max-chats]', panel).forEach(function (b) {
          b.disabled = true;
        });
        fetchMaxLinkedChannels(true)
          .then(function (data) {
            mountMaxChatsPanel(panel, data.channels || []);
            bindMaxChatsPanel(panel);
            refreshIcons();
            var n = (data.channels || []).length;
            var admins = data.adminCount != null ? data.adminCount : 0;
            var msg = n
              ? 'Каналов MAX: ' + n + (admins ? ', админ: ' + admins : '')
              : data.hint || 'Каналы не найдены';
            showToast(msg, n ? 'success' : 'info');
            var metaEl = qs('[data-max-channels-meta]');
            if (metaEl) {
              var admins = data.adminCount != null ? data.adminCount : 0;
              var vals = metaEl.querySelectorAll('.int-stat-val');
              if (vals[0]) vals[0].textContent = String(n);
              if (vals[1]) vals[1].textContent = String(admins);
            }
            var badge = qs('.int-card--max .int-details-badge', panel.closest('.integration-card') || document);
            if (badge) badge.textContent = String(n);
          })
          .catch(function (e) {
            showToast(e.message || 'Ошибка', 'error');
          })
          .finally(function () {
            qsa('[data-refresh-max-chats]', panel).forEach(function (b) {
              b.disabled = false;
            });
          });
      });
    });
  }

  function maxIntegrationCardHtml(meta) {
    var channels = maxLinkedChatsCache.length ? maxLinkedChatsCache : (meta && meta.channels) || [];
    var adminCount = channels.filter(function (c) {
      return c.botIsAdmin === true;
    }).length;
    var tokenPreview = (meta && meta.tokenPreview) || '';
    var channelsOpen = channels.length ? '' : ' open';
    return (
      '<article class="integration-card connected int-card--max">' +
      '<div class="int-card-header">' +
      '<div class="int-logo max">М</div>' +
      '<div class="int-info">' +
      '<div class="int-name">MAX</div>' +
      '<div class="int-desc">Целевая платформа — бот подключён через MAX_TOKEN</div>' +
      '</div>' +
      '<span class="int-status connected"><i data-lucide="circle-check"></i> Подключён</span>' +
      '</div>' +
      '<div class="int-quick-stats" data-max-channels-meta>' +
      '<div class="int-stat"><span class="int-stat-val">' +
      esc(String(channels.length)) +
      '</span><span class="int-stat-label">каналов</span></div>' +
      '<div class="int-stat"><span class="int-stat-val">' +
      esc(String(adminCount)) +
      '</span><span class="int-stat-label">админ</span></div>' +
      '<div class="int-stat"><span class="int-stat-val mono">••••' +
      esc(tokenPreview) +
      '</span><span class="int-stat-label">токен</span></div>' +
      '</div>' +
      '<details class="int-details"' +
      channelsOpen +
      '><summary><i data-lucide="radio"></i> Каналы MAX <span class="int-details-badge">' +
      esc(String(channels.length)) +
      '</span></summary>' +
      '<div class="int-details-body tg-chats-panel-wrap" data-max-chats-panel="1"></div></details>' +
      '</article>'
    );
  }

  function bindTelegramChatsPanel(panel) {
    if (!panel) return;
    qsa('[data-copy-tg-channel]', panel).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var v = btn.getAttribute('data-copy-tg-channel') || '';
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(v).then(function () {
            showToast('Скопировано: ' + v, 'success');
          });
        } else {
          showToast(v, 'info');
        }
      });
    });
    qsa('[data-refresh-tg-chats]', panel).forEach(function (ref) {
      ref.addEventListener('click', function () {
        var integrationId = ref.getAttribute('data-refresh-tg-chats');
        qsa('[data-refresh-tg-chats]', panel).forEach(function (b) {
          b.disabled = true;
        });
        fetchTelegramLinkedChats(true)
          .then(function (data) {
            mountTelegramChatsPanel(panel, integrationId, data.channels || []);
            bindTelegramChatsPanel(panel);
            refreshIcons();
            var n = (data.channels || []).length;
            var admins =
              data.adminCount != null
                ? data.adminCount
                : (data.channels || []).filter(function (c) {
                    return c.botIsAdmin;
                  }).length;
            var msg = n
              ? 'Сохранено чатов: ' + n + (admins ? ', админ: ' + admins : '')
              : data.hint || 'Чаты не найдены';
            showToast(msg, n ? 'success' : 'info');
          })
          .catch(function (e) {
            showToast(e.message || 'Ошибка', 'error');
          })
          .finally(function () {
            qsa('[data-refresh-tg-chats]', panel).forEach(function (b) {
              b.disabled = false;
            });
          });
      });
    });
  }

  function buildTelegramChannelSelect(id, chats, extraManualId, options) {
    options = options || {};
    var list = chats || [];
    if (options.adminOnly) {
      var adminOnly = list.filter(function (ch) {
        return ch.botIsAdmin === true;
      });
      if (adminOnly.length) list = adminOnly;
    }
    if (options.groupsOnly) {
      list = list.filter(function (ch) {
        return ch.type === 'group' || ch.type === 'supergroup';
      });
    }
    var savedValue = options.selectedValue || options.manualValue || '';
    var opts = '<option value="">— выберите канал/чат —</option>';
    list.forEach(function (ch) {
      var val = telegramChannelPickValue(ch);
      var label = ch.title + (ch.username ? ' (' + ch.username + ')' : '') + ' · ' + telegramChatTypeLabel(ch.type);
      if (ch.botIsAdmin) label += ' · админ';
      opts +=
        '<option value="' +
        esc(val) +
        '"' +
        (savedValue && telegramChannelPickValuesEqual(val, savedValue) ? ' selected' : '') +
        '>' +
        esc(label) +
        '</option>';
    });
    var html =
      '<select class="select" id="' +
      esc(id) +
      '">' +
      opts +
      '</select>';
    if (extraManualId) {
      html +=
        '<input class="input mt-sm mono" id="' +
        esc(extraManualId) +
        '" placeholder="или введите @username / -100..."';
      var savedInList =
        savedValue &&
        list.some(function (ch) {
          return telegramChannelPickValuesEqual(telegramChannelPickValue(ch), savedValue);
        });
      if (savedValue && !savedInList) {
        html += ' value="' + esc(String(savedValue)) + '"';
      }
      html += '/>';
    }
    return html;
  }

  function readTelegramChannelPick(selectId, manualId, root) {
    var sel = qs('#' + selectId, root);
    var fromSelect = sel ? String(sel.value || '').trim() : '';
    if (fromSelect) return fromSelect;
    var manual = manualId ? qs('#' + manualId, root) : null;
    return manual ? String(manual.value || '').trim() : '';
  }

  function showToast(msg, type) {
    var root = qs('#toastRoot');
    if (!root) return;
    var el = document.createElement('div');
    el.className = 'toast ' + (type === 'error' ? 'error' : type === 'success' ? 'success' : 'info');
    el.textContent = String(msg || '');
    root.appendChild(el);
    window.setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 4200);
  }

  function showConfirm(title, body, onConfirm) {
    var host = qs('#modalRoot');
    if (!host) return;
    var backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    var modal = document.createElement('div');
    modal.className = 'modal';
    var h = document.createElement('h2');
    h.textContent = String(title || '');
    var p = document.createElement('p');
    p.textContent = String(body || '');
    var actions = document.createElement('div');
    actions.className = 'modal-actions';
    var btnCancel = document.createElement('button');
    btnCancel.type = 'button';
    btnCancel.className = 'btn btn-ghost';
    btnCancel.textContent = 'Отмена';
    var btnOk = document.createElement('button');
    btnOk.type = 'button';
    btnOk.className = 'btn btn-danger';
    btnOk.textContent = 'Подтвердить';
    function close() {
      if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
    }
    btnCancel.addEventListener('click', close);
    btnOk.addEventListener('click', function () {
      close();
      if (typeof onConfirm === 'function') onConfirm();
    });
    actions.appendChild(btnCancel);
    actions.appendChild(btnOk);
    modal.appendChild(h);
    modal.appendChild(p);
    modal.appendChild(actions);
    backdrop.appendChild(modal);
    host.appendChild(backdrop);
  }

  var refreshIconsTimer = null;
  function refreshIcons(root) {
    if (typeof lucide === 'undefined' || !lucide.createIcons) return;
    if (refreshIconsTimer) {
      window.clearTimeout(refreshIconsTimer);
    }
    refreshIconsTimer = window.setTimeout(function () {
      refreshIconsTimer = null;
      var opts = { attrs: { 'stroke-width': 2 } };
      if (root && root.querySelectorAll) {
        try {
          lucide.createIcons(Object.assign({}, opts, { root: root }));
          return;
        } catch (_e) {
          /* fallback below */
        }
      }
      lucide.createIcons(opts);
    }, 16);
  }

  function toggleRow(key, label, hint, on) {
    return (
      '<div class="toggle-row" data-toggle-key="' +
      esc(key) +
      '">' +
      '<div><div class="toggle-label">' +
      esc(label) +
      '</div>' +
      (hint ? '<div class="toggle-hint">' + esc(hint) + '</div>' : '') +
      '</div><div class="switch' +
      (on ? ' on' : '') +
      '" role="switch" tabindex="0" aria-checked="' +
      (on ? 'true' : 'false') +
      '"></div></div>'
    );
  }

  function bindToggleRows(root, readState) {
    qsa('.toggle-row', root).forEach(function (row) {
      if (row.getAttribute('data-toggle-bound') === '1') return;
      var sw = qs('.switch', row);
      if (!sw) return;
      var key = row.getAttribute('data-toggle-key');
      if (!key) return;
      function flip() {
        var cur = sw.classList.contains('on');
        if (cur) {
          sw.classList.remove('on');
          sw.setAttribute('aria-checked', 'false');
        } else {
          sw.classList.add('on');
          sw.setAttribute('aria-checked', 'true');
        }
        if (readState) readState(key, !cur);
      }
      sw.addEventListener('click', flip);
      sw.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          flip();
        }
      });
      row.setAttribute('data-toggle-bound', '1');
    });
  }

  function readSwitches(root) {
    var out = {};
    qsa('.toggle-row', root).forEach(function (row) {
      var key = row.getAttribute('data-toggle-key');
      var sw = qs('.switch', row);
      if (key && sw) out[key] = sw.classList.contains('on');
    });
    return out;
  }

  function bindTagsInput(wrap, initialTags, onChange) {
    var tags = (initialTags || []).slice();
    function getTags(includePending) {
      var out = tags.slice();
      if (includePending !== false) {
        var inp = wrap.querySelector('.tags-input');
        var pending = inp ? String(inp.value || '').trim() : '';
        if (pending && out.indexOf(pending) === -1) out.push(pending);
      }
      return out;
    }
    wrap.__tagsGet = getTags;
    function render() {
      wrap.textContent = '';
      tags.forEach(function (t, idx) {
        var tag = document.createElement('span');
        tag.className = 'tag';
        tag.appendChild(document.createTextNode(t));
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.appendChild(document.createTextNode('×'));
        btn.addEventListener('click', function () {
          tags = tags.filter(function (_, i) {
            return i !== idx;
          });
          if (onChange) onChange(tags.slice());
          render();
        });
        tag.appendChild(btn);
        wrap.appendChild(tag);
      });
      var inp = document.createElement('input');
      inp.className = 'tags-input';
      inp.setAttribute('placeholder', 'Введите слово и Enter');
      inp.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        var v = inp.value.trim();
        if (v === '') return;
        if (tags.indexOf(v) === -1) tags.push(v);
        inp.value = '';
        if (onChange) onChange(tags.slice());
        render();
      });
      wrap.appendChild(inp);
    }
    render();
  }

  function clearDashTimer() {
    if (dashRefreshTimer) {
      window.clearInterval(dashRefreshTimer);
      dashRefreshTimer = null;
    }
  }

  function clearLogsTimer() {
    if (logsRefreshTimer) {
      window.clearInterval(logsRefreshTimer);
      logsRefreshTimer = null;
    }
  }

  function scheduleDashRefresh() {
    clearDashTimer();
    dashRefreshTimer = window.setInterval(function () {
      if (currentRoute === 'dashboard') {
        renderDashboard(false);
      }
    }, 60000);
  }

  function clearChannelImportPoll() {
    if (channelImportPollTimer) {
      window.clearInterval(channelImportPollTimer);
      channelImportPollTimer = null;
    }
    channelImportJobId = null;
  }

  function parseHashRoute() {
    var raw = (location.hash || '').replace(/^#/, '').trim();
    if (raw === '') return 'dashboard';
    var id = raw.split(/[/?]/)[0];
    if (id === 'dashboard_tg') {
      return 'dashboard';
    }
    var allowed = {
      dashboard: 1,
      channels: 1,
      tgchains: 1,
      channelimport: 1,
      autoposts: 1,
      integrations: 1,
      antispam: 1,
      comments: 1,
      users: 1,
      logs: 1,
      ailog: 1,
      settings: 1,
    };
    return allowed[id] ? id : 'dashboard';
  }

  function navigate(route) {
    if (location.hash.replace(/^#/, '') !== route) {
      location.hash = route;
    } else {
      handleRoute();
    }
  }

  function renderSidebar() {
    var nav = qs('#sidebarNav');
    if (!nav) return;
    var html = '';
    NAV.forEach(function (g) {
      html += '<p class="nav-group-label">' + esc(g.group) + '</p>';
      g.items.forEach(function (it) {
        html +=
          '<button type="button" class="nav-item' +
          (currentRoute === it.id ? ' active' : '') +
          '" data-route="' +
          esc(it.id) +
          '">' +
          '<i data-lucide="' +
          esc(it.icon) +
          '"></i>' +
          esc(it.label) +
          (it.badge
            ? '<span class="nav-badge">' + esc(it.badge) + '</span>'
            : '') +
          '</button>';
      });
    });
    nav.innerHTML = html;
    qsa('.nav-item', nav).forEach(function (btn) {
      btn.addEventListener('click', function () {
        navigate(btn.getAttribute('data-route') || 'dashboard');
        closeSidebarMobile();
      });
    });
    refreshIcons();
  }

  function setPageTitle() {
    var meta = PAGE_META[currentRoute] || { title: PAGE_TITLES[currentRoute] || 'Панель', group: '', desc: '' };
    var t = qs('#pageTitle');
    if (t) t.textContent = meta.title;
    var sub = qs('#pageSubtitle');
    if (sub) sub.textContent = meta.desc || '';
    var bc = qs('#pageBreadcrumb');
    if (bc) {
      if (meta.group && meta.group !== meta.title) {
        bc.innerHTML =
          '<span class="breadcrumb-group">' +
          esc(meta.group) +
          '</span><span class="breadcrumb-sep">/</span><span class="breadcrumb-current">' +
          esc(meta.title) +
          '</span>';
      } else {
        bc.innerHTML = '<span class="breadcrumb-current">' + esc(meta.title) + '</span>';
      }
    }
    document.title = meta.title + ' — CommentBot';
  }

  function closeSidebarMobile() {
    var sidebar = qs('#sidebar');
    var overlay = qs('#sidebarOverlay');
    if (sidebar) sidebar.classList.remove('open');
    if (overlay) overlay.classList.remove('visible');
  }

  function openSidebarMobile() {
    var sidebar = qs('#sidebar');
    var overlay = qs('#sidebarOverlay');
    if (sidebar) sidebar.classList.add('open');
    if (overlay) overlay.classList.add('visible');
  }

  function renderQuickNav() {
    var items = [
      { route: 'channels', icon: 'radio', label: 'Каналы', desc: 'MAX-каналы' },
      { route: 'comments', icon: 'message-square', label: 'Комментарии', desc: 'Модерация' },
      { route: 'tgchains', icon: 'link-2', label: 'Цепочки', desc: 'TG→MAX и MAX→VK' },
      { route: 'autoposts', icon: 'calendar-clock', label: 'Автопосты', desc: 'Расписание' },
      { route: 'antispam', icon: 'shield', label: 'Антиспам', desc: 'Фильтры' },
      { route: 'users', icon: 'users', label: 'Пользователи', desc: 'Ограничения' },
    ];
    var html = '<section class="quick-nav"><div class="quick-nav-head">';
    html += '<h2 class="quick-nav-title">Быстрый доступ</h2>';
    html += '</div><div class="quick-nav-grid">';
    items.forEach(function (it) {
      html +=
        '<button type="button" class="quick-nav-card" data-route="' +
        esc(it.route) +
        '"><i data-lucide="' +
        esc(it.icon) +
        '"></i><span class="quick-nav-card-label">' +
        esc(it.label) +
        '</span><span class="quick-nav-card-desc">' +
        esc(it.desc) +
        '</span></button>';
    });
    html += '</div></section>';
    return html;
  }

  function bindQuickNav(root) {
    if (!root) return;
    qsa('.quick-nav-card', root).forEach(function (btn) {
      btn.addEventListener('click', function () {
        navigate(btn.getAttribute('data-route') || 'dashboard');
        closeSidebarMobile();
      });
    });
  }

  function sectionHead(title, desc) {
    return (
      '<div class="content-block-head"><div><h3>' +
      esc(title) +
      '</h3>' +
      (desc ? '<p class="block-desc">' + esc(desc) + '</p>' : '') +
      '</div></div>'
    );
  }

  function emptyState(iconName, title, desc, btnHtml) {
    return (
      '<div class="empty-state">' +
      '<i data-lucide="' +
      esc(iconName) +
      '" style="width:40px;height:40px;opacity:0.35"></i>' +
      '<h3>' +
      esc(title) +
      '</h3>' +
      '<p>' +
      esc(desc) +
      '</p>' +
      (btnHtml || '') +
      '</div>'
    );
  }

  function skeletonPage(rows) {
    var n = rows || 4;
    var cards = '';
    for (var i = 0; i < (n > 4 ? 4 : n); i++) {
      cards +=
        '<div class="metric-card"><div class="skeleton skeleton-text" style="width:55%;margin-bottom:0.5rem"></div><div class="skeleton skeleton-title"></div></div>';
    }
    return (
      '<div class="metrics-grid">' +
      cards +
      '</div>' +
      '<div class="panel"><div class="skeleton skeleton-text"></div><div class="skeleton skeleton-text" style="width:80%"></div><div class="skeleton skeleton-text" style="width:60%"></div></div>'
    );
  }

  function setTopbarActions(html) {
    var el = qs('#topbarActions');
    if (el) el.innerHTML = html || '';
    refreshIcons();
  }

  function activityIconName(type) {
    switch (type) {
      case 'new_subscriber':
        return 'user-plus';
      case 'new_comment':
        return 'message-square';
      case 'new_post_button':
        return 'pointer';
      case 'admin_reply':
        return 'reply';
      case 'channel_added':
        return 'radio';
      case 'channel_removed':
        return 'slash';
      case 'antispam_block':
        return 'shield-off';
      default:
        return 'activity';
    }
  }

  function fmtNum(n) {
    if (n == null || !Number.isFinite(Number(n))) return '—';
    return String(n);
  }

  function fmtPct(n) {
    if (n == null || !Number.isFinite(Number(n))) return '—';
    return (Math.round(Number(n) * 10) / 10).toFixed(1) + '%';
  }


  function formatRelativeTime(iso) {
    if (!iso) return '—';
    var t = Date.parse(iso);
    if (!Number.isFinite(t)) return String(iso);
    var diff = Date.now() - t;
    var sec = Math.floor(diff / 1000);
    if (sec < 45) return 'только что';
    var min = Math.floor(sec / 60);
    if (min < 60) return min + ' мин назад';
    var hr = Math.floor(min / 60);
    if (hr < 24) return hr + ' ч назад';
    var day = Math.floor(hr / 24);
    if (day === 1) return 'вчера';
    if (day < 7) return day + ' дн назад';
    return new Date(t).toLocaleString('ru-RU', {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  }

  function renderHomeBotLauncher() {
    var tgUrl = 'https://t.me/commentvmax_bot';
    var maxUrl = 'https://max.ru/id683003981770_bot';
    return (
      '<section class="home-bot-launcher">' +
      '<div class="home-bot-launcher-head">' +
      '<h2 class="home-bot-launcher-title">Боты CommentBot</h2>' +
      '<p class="home-bot-launcher-sub muted">Откройте нужную платформу — управление каналами и комментариями в одном месте.</p>' +
      '</div>' +
      '<div class="home-bot-grid">' +
      '<a class="home-bot-card home-bot-card--tg" target="_blank" rel="noopener noreferrer" href="' +
      esc(tgUrl) +
      '">' +
      '<div class="home-bot-card-top">' +
      '<span class="home-bot-platform tg">Telegram</span>' +
      '<i data-lucide="send"></i></div>' +
      '<div class="home-bot-card-title">@commentvmax_bot</div>' +
      '<p class="home-bot-card-desc">Уведомления админам, TG-каналы и переход к комментариям из Telegram.</p>' +
      '<span class="home-bot-card-cta">Открыть в Telegram <i data-lucide="external-link"></i></span>' +
      '</a>' +
      '<a class="home-bot-card home-bot-card--max" target="_blank" rel="noopener noreferrer" href="' +
      esc(maxUrl) +
      '">' +
      '<div class="home-bot-card-top">' +
      '<span class="home-bot-platform max">MAX</span>' +
      '<i data-lucide="layout-dashboard"></i></div>' +
      '<div class="home-bot-card-title">MAX CommentBot</div>' +
      '<p class="home-bot-card-desc">Комментарии к постам MAX-каналов, мини-приложение и ответы администраторов.</p>' +
      '<span class="home-bot-card-cta">Открыть в MAX <i data-lucide="external-link"></i></span>' +
      '</a></div></section>'
    );
  }

  function renderDashPlatformHeading(platform, title, subtitle) {
    var badgeClass = platform === 'telegram' ? 'tg' : 'max';
    var badgeLabel = platform === 'telegram' ? 'Telegram' : 'MAX';
    return (
      '<div class="dash-platform-head">' +
      '<h2 class="dash-platform-title"><span class="dash-platform-badge ' +
      esc(badgeClass) +
      '">' +
      esc(badgeLabel) +
      '</span>' +
      esc(title) +
      '</h2>' +
      (subtitle ? '<p class="dash-platform-sub muted">' + esc(subtitle) + '</p>' : '') +
      '</div>'
    );
  }

  function renderMaxDashboardSection(d, act, periodLabel) {
    var eff = d.effectiveness || {};
    var score = Number(eff.score) || 0;
    var funnel = d.funnel || {};
    var totals = d.totals || {};
    var ts = d.timeseries || [];
    var chans = d.channels || [];
    var insights = eff.insights || [];
    var events = (act && act.events) || [];
    var html =
      '<section class="dash-platform-section dash-platform-section--max">' +
      renderDashPlatformHeading('max', 'Метрики MAX', 'Каналы, комментарии и эффективность за выбранный период.') +
      '<div class="dash-platform-body">';
        html += '<div class="dash-grid-top">';
        html += '<div class="eff-card">';
        html +=
          '<div class="eff-ring" style="--pct:' +
          esc(String(Math.min(100, Math.max(0, score)))) +
          '"><span class="eff-score">' +
          esc(String(Math.round(score))) +
          '</span></div>';
        html += '<p class="eff-label">' + esc(eff.label || 'Эффективность') + '</p>';
        html +=
          '<span class="eff-grade ' +
          esc(eff.grade || 'fair') +
          '">' +
          esc(periodLabel) +
          '</span>';
        html += '</div>';
        html += '<div class="metric-bars">';
        html +=
          '<div class="metric-row"><span>Комм. / пост</span><div class="bar-track"><div class="bar-fill" style="width:' +
          esc(String(Math.min(100, (eff.engagement_rate || 0) * 25))) +
          '%"></div></div><span class="val">' +
          esc((Math.round((eff.engagement_rate || 0) * 100) / 100).toFixed(2)) +
          '</span></div>';
        html +=
          '<div class="metric-row"><span>Ответы админов</span><div class="bar-track"><div class="bar-fill" style="width:' +
          esc(String(Math.min(100, eff.reply_rate || 0))) +
          '%"></div></div><span class="val">' +
          esc(fmtPct(eff.reply_rate || 0)) +
          '</span></div>';
        html +=
          '<div class="metric-row"><span>Охват каналов</span><div class="bar-track"><div class="bar-fill" style="width:' +
          esc(String(Math.min(100, eff.coverage_rate || 0))) +
          '%"></div></div><span class="val">' +
          esc(fmtPct(eff.coverage_rate || 0)) +
          '</span></div>';
        html +=
          '<div class="metric-row"><span>Активация</span><div class="bar-track"><div class="bar-fill" style="width:' +
          esc(String(Math.min(100, eff.activation_rate || 0))) +
          '%"></div></div><span class="val">' +
          esc(fmtPct(eff.activation_rate || 0)) +
          '</span></div>';
        html += '</div></div>';
        html += '<div class="stats-grid">';
        html += '<div class="metric-card">';
        html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.4rem">';
        html += '<div class="metric-card-icon" style="color:var(--text-muted)"><i data-lucide="radio" style="width:16px;height:16px"></i></div>';
        html += '</div>';
        html += '<div class="label">Каналы</div><div class="value">' + esc(fmtNum(totals.channels)) + '</div>';
        html += '<div class="sub">активных: ' + esc(fmtNum(totals.channels_active)) + '</div></div>';
        html += '<div class="metric-card">';
        html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.4rem">';
        html += '<div class="metric-card-icon" style="color:var(--text-muted)"><i data-lucide="users" style="width:16px;height:16px"></i></div>';
        if (totals.subscribers_in_period) {
          html += '<span class="delta positive">+' + esc(fmtNum(totals.subscribers_in_period)) + '</span>';
        }
        html += '</div>';
        html += '<div class="label">Подписчики бота</div><div class="value">' + esc(fmtNum(totals.bot_subscribers)) + '</div>';
        html += '<div class="sub">за период: +' + esc(fmtNum(totals.subscribers_in_period)) + '</div></div>';
        html += '<div class="metric-card">';
        html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.4rem">';
        html += '<div class="metric-card-icon" style="color:var(--text-muted)"><i data-lucide="file-text" style="width:16px;height:16px"></i></div>';
        if (totals.posts_in_period) {
          html += '<span class="delta positive">+' + esc(fmtNum(totals.posts_in_period)) + '</span>';
        }
        html += '</div>';
        html += '<div class="label">Посты</div><div class="value">' + esc(fmtNum(totals.posts)) + '</div>';
        html += '<div class="sub">в периоде: ' + esc(fmtNum(totals.posts_in_period)) + '</div></div>';
        html += '<div class="metric-card">';
        html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.4rem">';
        html += '<div class="metric-card-icon" style="color:var(--text-muted)"><i data-lucide="message-square" style="width:16px;height:16px"></i></div>';
        if (totals.comments_in_period) {
          html += '<span class="delta positive">+' + esc(fmtNum(totals.comments_in_period)) + '</span>';
        }
        html += '</div>';
        html += '<div class="label">Комментарии</div><div class="value">' + esc(fmtNum(totals.comments)) + '</div>';
        html += '<div class="sub">в периоде: ' + esc(fmtNum(totals.comments_in_period)) + '</div></div>';
        html +=
          '<div class="stat-card"><div class="label">Уникальные авторы</div><div class="value">' +
          esc(fmtNum(totals.unique_commenters_in_period)) +
          '</div><div class="sub">всего: ' +
          esc(fmtNum(totals.unique_commenters_all)) +
          '</div></div>';
        html +=
          '<div class="stat-card"><div class="label">Ответы админов</div><div class="value">' +
          esc(fmtNum(totals.admin_replies_in_period)) +
          '</div><div class="sub">за выбранный период</div></div>';
        html += '</div>';
        html += sectionHead('Воронка аудитории', 'Путь от подписки на бота до активности в мини-приложении');
        html += '<div class="funnel">';
        html +=
          '<div class="funnel-step"><div class="num">' +
          esc(fmtNum(funnel.bot_subscribers)) +
          '</div><div class="lbl">Подписчики бота</div></div>';
        html +=
          '<div class="funnel-step"><div class="num">' +
          esc(fmtNum(funnel.notify_opt_ins)) +
          '</div><div class="lbl">Уведомления</div></div>';
        html +=
          '<div class="funnel-step"><div class="num">' +
          esc(fmtNum(funnel.unique_commenters)) +
          '</div><div class="lbl">Комментаторы</div></div>';
        html +=
          '<div class="funnel-step"><div class="num">' +
          esc(fmtNum(funnel.miniapp_users)) +
          '</div><div class="lbl">Мини-приложение</div></div>';
        html += '</div>';
        html += sectionHead('Активность по дням', 'Количество комментариев за каждый день периода');
        html += '<div class="chart-wrap">';
        var maxC = 1;
        ts.forEach(function (pt) {
          maxC = Math.max(maxC, pt.comments || 0);
        });
        ts.forEach(function (pt) {
          var hPct = Math.round(((pt.comments || 0) / maxC) * 100);
          html += '<div class="chart-bar-col">';
          html +=
            '<div class="chart-bar" style="height:' +
            esc(String(hPct)) +
            '%" title="' +
            esc(String(pt.comments || 0)) +
            '"></div>';
          html += '<div class="chart-lbl">' + esc((pt.date || '').slice(5)) + '</div>';
          html += '</div>';
        });
        html += '</div>';
        html += sectionHead('Каналы', 'Нажмите на канал, чтобы открыть настройки');
        html += '<div class="channel-cards">';
        chans.forEach(function (c) {
          var initials = (c.title || 'CH').slice(0, 2).toUpperCase();
          var stBadge =
            c.status === 'pending'
              ? '<span class="badge badge-warn">Ожидает</span>'
              : '<span class="badge badge-ok">Активен</span>';
          html +=
            '<a class="channel-card" href="#channels" data-chat-id="' +
            esc(String(c.chat_id)) +
            '"><div class="channel-card-title"><span class="channel-avatar">' +
            esc(initials) +
            '</span><span><strong>' +
            esc(c.title || 'Канал ' + c.chat_id) +
            '</strong><span class="channel-card-meta mono">' +
            esc(String(c.chat_id)) +
            '</span></span>' +
            stBadge +
            '</div><div class="channel-card-meta">' +
            esc(fmtNum(c.comment_count)) +
            ' комм. · ' +
            esc(fmtNum(c.post_count)) +
            ' постов · ' +
            esc(fmtNum(c.comments_in_period)) +
            ' за период</div></a>';
        });
        if (chans.length === 0) {
          html += '<p class="muted">Нет подключённых каналов</p>';
        }
        html += '</div>';
        html += sectionHead('Инсайты', 'Автоматические рекомендации по данным периода');
        html += '<ul class="insights-list">';
        insights.forEach(function (line) {
          html += '<li>' + esc(line) + '</li>';
        });
        html += '</ul>';
        html += sectionHead('Лента активности', 'Последние события в системе');
        html += '<div class="activity-feed">';
        events.forEach(function (ev) {
          var label = ACTIVITY_LABELS[ev.type] || ev.type;
          var ic = activityIconName(ev.type);
          html += '<div class="activity-item">';
          html += '<div class="activity-icon"><i data-lucide="' + esc(ic) + '"></i></div>';
          html += '<div class="activity-body">';
          html += '<div class="activity-title">' + esc(label) + '</div>';
          html +=
            '<div class="activity-meta">' +
            esc(ev.channel_name || '') +
            ' · ' +
            esc(formatRelativeTime(ev.timestamp)) +
            '</div>';
          if (ev.preview) {
            html += '<div class="activity-preview">' + esc(ev.preview) + '</div>';
          }
          html += '</div></div>';
        });
    if (events.length === 0) {
      html += '<p class="muted">Событий пока нет</p>';
    }
    html += '</div></div></section>';
    return html;
  }

  function renderTelegramDashboardSection(data) {
    var totals = data.totals || {};
    var channels = data.channels || [];
    var recent = data.recent_forwarded || [];
    var html =
      '<section class="dash-platform-section dash-platform-section--tg">' +
      renderDashPlatformHeading(
        'telegram',
        'Метрики Telegram',
        'Каналы, администраторы и журнал пересылок TG → MAX.',
      ) +
      '<div class="dash-platform-body">';
        html += '<div class="stats-grid">';
        html +=
          '<div class="stat-card"><div class="label">Telegram каналы</div><div class="value">' +
          esc(fmtNum(totals.channels)) +
          '</div><div class="sub">бот админ: ' +
          esc(fmtNum(totals.channels_admin)) +
          '</div></div>';
        html +=
          '<div class="stat-card"><div class="label">Администраторы Telegram</div><div class="value">' +
          esc(fmtNum(totals.admins_total)) +
          '</div><div class="sub">запустили бота: ' +
          esc(fmtNum(totals.admins_started)) +
          '</div></div>';
        html +=
          '<div class="stat-card"><div class="label">Активные TG потоки</div><div class="value">' +
          esc(fmtNum(totals.flows_active)) +
          '</div><div class="sub">связки TG ↔ MAX</div></div>';
        html +=
          '<div class="stat-card"><div class="label">Последние пересылки</div><div class="value">' +
          esc(fmtNum(totals.forwarded_total)) +
          '</div><div class="sub">из журнала интеграций</div></div>';
        html += '</div>';
        html += '<h3>Telegram каналы</h3><div class="channel-cards">';
        channels.forEach(function (ch) {
          var admins = Array.isArray(ch.admins) ? ch.admins : [];
          html += '<div class="channel-card">';
          html +=
            '<div class="channel-card-title"><span class="channel-avatar">TG</span><span><strong>' +
            esc(ch.title || 'Telegram канал') +
            '</strong><span class="channel-card-meta mono">' +
            esc(ch.username || ch.id || '—') +
            '</span></span><span class="badge ' +
            (ch.botIsAdmin ? 'badge-active' : 'badge-pending') +
            '">' +
            esc(ch.botIsAdmin ? 'бот админ' : 'бот не админ') +
            '</span></div>';
          html +=
            '<div class="channel-card-meta">' +
            esc(telegramChatTypeLabel(ch.type)) +
            ' · ID ' +
            esc(String(ch.id || '')) +
            ' · админов: ' +
            esc(String(ch.admins_total || admins.length || 0)) +
            ' · запустили: ' +
            esc(String(ch.admins_started || 0)) +
            '</div>';
          if (admins.length) {
            html += '<ul class="muted" style="margin:8px 0 0 16px;padding:0">';
            admins.forEach(function (a) {
              html +=
                '<li style="list-style:disc">' +
                (a.started_bot ? '✅ ' : '⚠️ ') +
                esc(a.name || String(a.user_id)) +
                (a.username ? ' <span class="mono text-sm">' + esc(String(a.username)) + '</span>' : '') +
                (a.is_creator ? ' <span class="muted">(владелец)</span>' : '') +
                '</li>';
            });
            html += '</ul>';
          }
          html += '</div>';
        });
        if (!channels.length) {
          html +=
            '<p class="muted">Telegram каналы не найдены. <button type="button" class="btn btn-ghost btn-sm" data-route-jump="integrations">Подключить Telegram</button></p>';
        }
        html += '</div>';

        html += '<h3 class="mt-md">Журнал TG пересылок</h3><div class="activity-feed">';
        recent.forEach(function (ev) {
          html += '<div class="activity-item">';
          html += '<div class="activity-icon"><i data-lucide="arrow-right-left"></i></div>';
          html += '<div class="activity-body">';
          html +=
            '<div class="activity-title">' +
            esc((ev.fromPlatform || '?') + ' → ' + (ev.toPlatform || '?')) +
            '</div>';
          html +=
            '<div class="activity-meta">' +
            esc((ev.fromChannel || '—') + ' → ' + (ev.toChannel || '—')) +
            ' · ' +
            esc(formatRelativeTime(ev.forwardedAt)) +
            '</div>';
          if (ev.preview) {
            html += '<div class="activity-preview">' + esc(ev.preview) + '</div>';
          }
          html += '</div></div>';
        });
    if (!recent.length) {
      html += '<p class="muted">Пока нет событий Telegram пересылок</p>';
    }
    html += '</div></div></section>';
    return html;
  }

  function renderDashboard(showLoading) {
    var main = qs('#mainContent');
    if (!main) return;
    var seq = ++dashLoadSeq;
    if (showLoading !== false) {
      main.innerHTML = skeletonPage();
    }
    var periodLabel =
      dashPeriodDays === 0 ? 'всё время' : dashPeriodDays === 30 ? '30 дней' : '7 дней';
    var dashPath = '/dashboard?days=' + encodeURIComponent(String(dashPeriodDays));
    var tgPath = '/dashboard-telegram?days=' + encodeURIComponent(String(dashPeriodDays));

    Promise.all([getJson(dashPath), getJson('/activity?limit=20')])
      .then(function (parts) {
        if (seq !== dashLoadSeq || currentRoute !== 'dashboard') return;
        var d = parts[0];
        var act = parts[1];
        var html = renderQuickNav();
        html += renderMaxDashboardSection(d, act, periodLabel);
        html += renderHomeBotLauncher();
        html +=
          '<div id="dashTgSlot" class="dash-loading muted" style="padding:1rem 0">Загрузка метрик Telegram…</div>';
        main.innerHTML = html;
        bindQuickNav(main);
        refreshIcons(main);

        getJson(tgPath)
          .then(function (tgData) {
            if (seq !== dashLoadSeq || currentRoute !== 'dashboard') return;
            var slot = qs('#dashTgSlot', main);
            if (!slot) return;
            slot.outerHTML = renderTelegramDashboardSection(tgData);
            bindRouteJumpButtons(main);
            refreshIcons(main);
          })
          .catch(function () {
            if (seq !== dashLoadSeq || currentRoute !== 'dashboard') return;
            var slot = qs('#dashTgSlot', main);
            if (slot) {
              slot.outerHTML =
                '<section class="dash-platform-section dash-platform-section--tg"><p class="muted">Метрики Telegram временно недоступны</p></section>';
            }
          });
      })
      .catch(function (err) {
        if (err && err.message === 'auth') return;
        if (seq !== dashLoadSeq || currentRoute !== 'dashboard') return;
        main.innerHTML =
          '<p class="muted">Не удалось загрузить дашборд: ' + esc(err.message || String(err)) + '</p>';
      });
  }

  function paintChannelsList(main) {
    if (!main) main = qs('#mainContent');
    if (!main) return;
    var html = '<div class="split-view"><div class="split-list">';
    if (channelsCache.length === 0) {
      html += '<p class="muted" style="padding:0.5rem">Каналы не подключены</p>';
    } else {
      channelsCache.forEach(function (c) {
        var active = c.chat_id === selectedChannelId;
        html +=
          '<button type="button" class="list-item list-item-channel' +
          (active ? ' active' : '') +
          '" data-cid="' +
          esc(String(c.chat_id)) +
          '">';
        var title = c.title || 'Канал ' + c.chat_id;
        html += '<div class="list-item-row">';
        html += channelAvatarHtml(c.avatar_url, title, 'list-avatar');
        html += '<div class="list-item-body">';
        html += '<div class="list-item-title">' + esc(title) + '</div>';
        html +=
          '<div class="list-item-sub">' +
          esc(c.status === 'pending' ? 'Ожидает прав' : 'Активен') +
          ' · ' +
          esc(fmtNum(c.comment_count)) +
          ' коммент.</div>';
        html += '</div></div></button>';
      });
    }
    html += '</div><div class="split-detail" id="channelDetail">';
    if (!selectedChannelId) {
      html += '<p class="muted">Выберите канал слева</p>';
    } else {
      html += '<div class="dash-loading muted">Загрузка…</div>';
    }
    html += '</div></div>';
    main.innerHTML = html;
    qsa('.list-item', main).forEach(function (btn) {
      btn.addEventListener('click', function () {
        selectedChannelId = Number(btn.getAttribute('data-cid'));
        channelDetailTab = 'stats';
        channelSettingsEditing = false;
        channelAntispamEditing = false;
        qsa('.list-item-channel', main).forEach(function (item) {
          item.classList.toggle('active', Number(item.getAttribute('data-cid')) === selectedChannelId);
        });
        var slot = qs('#channelDetail', main);
        if (slot) {
          slot.innerHTML = '<div class="dash-loading muted">Загрузка…</div>';
        }
        loadChannelDetail(selectedChannelId);
      });
    });
    if (selectedChannelId) {
      loadChannelDetail(selectedChannelId);
    } else {
      refreshIcons(main);
    }
  }

  function renderChannels(forceReload) {
    var main = qs('#mainContent');
    if (!main) return;
    if (forceReload !== false || !channelsCache.length || channelsCacheLight) {
      main.innerHTML = skeletonPage();
      getJson('/channels')
        .then(function (data) {
          if (currentRoute !== 'channels') return;
          channelsCache = data.channels || [];
          channelsCacheLight = false;
          if (selectedChannelId && !channelsCache.some(function (c) { return c.chat_id === selectedChannelId; })) {
            selectedChannelId = null;
          }
          paintChannelsList(main);
        })
        .catch(function (err) {
          if (err && err.message === 'auth') return;
          if (currentRoute !== 'channels') return;
          main.innerHTML =
            '<p class="muted">Ошибка: ' + esc(err.message || String(err)) + '</p>';
        });
      return;
    }
    paintChannelsList(main);
  }

  function loadChannelDetail(chatId) {
    var slot = qs('#channelDetail');
    if (!slot) return;
    getJson('/channel/' + encodeURIComponent(String(chatId)))
      .then(function (detail) {
        if (currentRoute !== 'channels' || selectedChannelId !== chatId) return;
        var ch = detail.channel || {};
        var settings = detail.settings || {};
        var channelTitle = ch.title || 'Канал ' + chatId;
        var statusLabel = ch.status === 'pending' ? 'Ожидает прав' : 'Активен';
        var html = '<div class="channel-detail-head flex-between mb-md">';
        html += '<div class="channel-detail-intro">';
        html += channelAvatarHtml(ch.avatar_url, channelTitle, 'channel-detail-avatar');
        html += '<div class="channel-detail-head-text">';
        html += '<h2 style="margin:0">' + esc(channelTitle) + '</h2>';
        html +=
          '<span class="channel-detail-status ' +
          esc(ch.status === 'pending' ? 'pending' : 'active') +
          '">' +
          esc(statusLabel) +
          '</span>';
        html += '</div></div>';
        html += '<div class="flex gap-sm">';
        html +=
          '<button type="button" class="btn btn-ghost btn-sm" id="btnRefreshBtns">Обновить кнопки</button>';
        html += '<span id="refreshButtonsStatus" class="muted text-sm" style="align-self:center"></span>';
        html +=
          '<button type="button" class="btn btn-danger btn-sm" id="btnRemoveChannel">Отключить</button>';
        html += '</div></div>';
        html += '<div class="tabs" id="chTabs">';
        html +=
          '<button type="button" class="tab' +
          (channelDetailTab === 'stats' ? ' active' : '') +
          '" data-tab="stats">Статистика</button>';
        html +=
          '<button type="button" class="tab' +
          (channelDetailTab === 'settings' ? ' active' : '') +
          '" data-tab="settings">Настройки</button>';
        html +=
          '<button type="button" class="tab' +
          (channelDetailTab === 'antispam' ? ' active' : '') +
          '" data-tab="antispam">Антиспам</button>';
        html += '</div>';
        if (channelDetailTab === 'stats') {
          html += '<div class="stats-grid">';
          html +=
            '<div class="stat-card"><div class="label">Подписчики</div><div class="value">' +
            esc(fmtNum(ch.subscribers)) +
            '</div></div>';
          html +=
            '<div class="stat-card"><div class="label">Посты</div><div class="value">' +
            esc(fmtNum(ch.post_count)) +
            '</div></div>';
          html +=
            '<div class="stat-card"><div class="label">Комментарии</div><div class="value">' +
            esc(fmtNum(ch.comment_count)) +
            '</div></div>';
          html +=
            '<div class="stat-card"><div class="label">Добавлен</div><div class="value text-sm">' +
            esc(ch.date_added || '—') +
            '</div></div>';
          html += '</div>';
          html += '<h3 class="section-title">Последние комментарии</h3>';
          html += renderRecentComments(detail.recent_comments || []);
        } else if (channelDetailTab === 'settings') {
          html += renderChannelSettingsPanel(settings, channelSettingsEditing);
        } else {
          html += renderChannelAntispamPanel(settings, channelAntispamEditing);
        }
        slot.innerHTML = html;
        qsa('#chTabs .tab', slot).forEach(function (t) {
          t.addEventListener('click', function () {
            var nextTab = t.getAttribute('data-tab') || 'stats';
            if (nextTab !== channelDetailTab) {
              channelSettingsEditing = false;
              channelAntispamEditing = false;
            }
            channelDetailTab = nextTab;
            loadChannelDetail(chatId);
          });
        });
        var btnRef = qs('#btnRefreshBtns', slot);
        var refreshStatusEl = qs('#refreshButtonsStatus', slot);
        function setRefreshStatus(text, isError) {
          if (!refreshStatusEl) return;
          refreshStatusEl.textContent = text || '';
          refreshStatusEl.style.color = isError ? '#ef4444' : '';
        }
        if (btnRef) {
          btnRef.addEventListener('click', function () {
            btnRef.disabled = true;
            var prevText = btnRef.textContent;
            btnRef.textContent = 'Обновляем...';
            setRefreshStatus('Проверяем посты и восстанавливаем ссылки…', false);
            postJson('/refresh-buttons', { chat_id: chatId })
              .then(function (r) {
                var created = r && typeof r.created === 'number' ? r.created : 0;
                var refreshed = r && typeof r.refreshed === 'number' ? r.refreshed : 0;
                var failed = r && typeof r.failed === 'number' ? r.failed : 0;
                var fetched = r && typeof r.messages_fetched === 'number' ? r.messages_fetched : 0;
                var postsInDb = r && typeof r.posts_in_db === 'number' ? r.posts_in_db : 0;
                var restoredFromLogs =
                  r && typeof r.restored_from_logs === 'number' ? r.restored_from_logs : 0;
                var diagSignals =
                  r && r.diagnostics && typeof r.diagnostics.signals_total === 'number'
                    ? r.diagnostics.signals_total
                    : 0;
                if (fetched === 0 && postsInDb === 0) {
                  setRefreshStatus('Не удалось получить сообщения канала', true);
                  showToast('Сообщения канала не получены — проверьте права бота', 'error');
                  return;
                }
                if (created === 0 && refreshed === 0) {
                  var errHint =
                    failed > 0
                      ? 'ошибок при привязке: ' + failed
                      : 'нет прав или только служебные сообщения';
                  showToast(
                    'Кнопки не обновлены (' +
                      errHint +
                      '). В базе ' +
                      postsInDb +
                      ' постов, просмотрено ' +
                      fetched +
                      ' сообщ.',
                    'error',
                  );
                  setRefreshStatus('Кнопки не обновлены: ' + errHint, true);
                  return;
                }
                showToast(
                  'Готово: ' +
                    created +
                    ' новых, ' +
                    refreshed +
                    ' обновлено (в базе ' +
                    postsInDb +
                    ' постов, просмотрено ' +
                    fetched +
                    ' сообщ., восстановлено по диагностике ' +
                    restoredFromLogs +
                    ', сигналов в логах ' +
                    diagSignals +
                    ')',
                  'success',
                );
                setRefreshStatus(
                  'Готово: обновлено ' + refreshed + ', новых ' + created + ', восстановлено ' + restoredFromLogs,
                  false,
                );
                loadChannelDetail(chatId);
              })
              .catch(function (e) {
                var msg = e && e.message ? e.message : 'неизвестно';
                if (msg === 'Failed to fetch') {
                  msg = 'Нет ответа от сервера. Проверьте, что бот запущен и /api/admin доступен.';
                } else if (msg === 'The operation was aborted.') {
                  msg = 'Запрос выполнялся слишком долго и был прерван. Повторите ещё раз.';
                }
                setRefreshStatus('Ошибка: ' + msg, true);
                showToast(msg, 'error');
              })
              .finally(function () {
                btnRef.disabled = false;
                btnRef.textContent = prevText || 'Обновить кнопки';
              });
          });
        }
        var btnRm = qs('#btnRemoveChannel', slot);
        if (btnRm) {
          btnRm.addEventListener('click', function () {
            showConfirm(
              'Отключить канал?',
              'CommentBot покинет канал, все данные (посты, комментарии, привязки) будут удалены. Администраторам канала придёт уведомление. Продолжить?',
              function () {
                postJson('/remove-channel', { chat_id: chatId })
                  .then(function () {
                    showToast('Канал отключён', 'success');
                    selectedChannelId = null;
                    channelsCache = [];
                    channelsCacheLight = false;
                    renderChannels(true);
                  })
                  .catch(function (e) {
                    showToast(e.message || 'Ошибка', 'error');
                  });
              },
            );
          });
        }
        var btnEditSettings = qs('#btnEditChannelSettings', slot);
        if (btnEditSettings) {
          btnEditSettings.addEventListener('click', function () {
            channelSettingsEditing = true;
            loadChannelDetail(chatId);
          });
        }
        var btnCancelSettings = qs('#btnCancelChannelSettings', slot);
        if (btnCancelSettings) {
          btnCancelSettings.addEventListener('click', function () {
            channelSettingsEditing = false;
            loadChannelDetail(chatId);
          });
        }
        var setRoot = qs('#chSettingsForm', slot);
        if (setRoot) {
          bindToggleRows(setRoot, null);
          var save = qs('#btnSaveChannel', slot);
          if (save) {
            save.addEventListener('click', function () {
              showConfirm(
                'Сохранить настройки?',
                'Изменения будут применены к каналу.',
                function () {
                  var sw = readSwitches(setRoot);
                  var body = {
                    button_text: (qs('#f_btn_text', slot) && qs('#f_btn_text', slot).value) || '',
                    welcome_message: (qs('#f_welcome', slot) && qs('#f_welcome', slot).value) || '',
                    notify_admin: !!sw.notify_admin,
                    show_reactions: !!sw.show_reactions,
                    moderation_mode: !!sw.moderation_mode,
                  };
                  postJson('/channel/' + encodeURIComponent(String(chatId)) + '/settings', body)
                    .then(function () {
                      showToast('Сохранено', 'success');
                      channelSettingsEditing = false;
                      loadChannelDetail(chatId);
                    })
                    .catch(function (e) {
                      showToast(e.message || 'Ошибка', 'error');
                    });
                },
              );
            });
          }
        }
        var btnEditAntispam = qs('#btnEditChannelAntispam', slot);
        if (btnEditAntispam) {
          btnEditAntispam.addEventListener('click', function () {
            channelAntispamEditing = true;
            loadChannelDetail(chatId);
          });
        }
        var btnCancelAntispam = qs('#btnCancelChannelAntispam', slot);
        if (btnCancelAntispam) {
          btnCancelAntispam.addEventListener('click', function () {
            channelAntispamEditing = false;
            loadChannelDetail(chatId);
          });
        }
        var asRoot = qs('#chAntispamForm', slot);
        if (asRoot) {
          bindToggleRows(asRoot, null);
          var wrap = qs('#chStopwords', slot);
          if (wrap) {
            bindTagsInput(wrap, settings.stopwords || [], function () {});
          }
          var saveAs = qs('#btnSaveAntispamCh', slot);
          if (saveAs) {
            saveAs.addEventListener('click', function () {
              showConfirm(
                'Сохранить антиспам?',
                'Правила будут применены к каналу.',
                function () {
                  var sw2 = readSwitches(asRoot);
                  var tags = [];
                  if (wrap) {
                    qsa('.tag', wrap).forEach(function (tg) {
                      var txt = tg.firstChild;
                      if (txt && txt.nodeType === 3) tags.push(String(txt.textContent || '').trim());
                    });
                  }
                  postJson('/antispam/channel/' + encodeURIComponent(String(chatId)), {
                    stopwords: tags,
                    block_links: !!sw2.block_links,
                    flood_protection: !!sw2.flood_protection,
                    auto_mute: !!sw2.auto_mute,
                  })
                    .then(function () {
                      showToast('Сохранено', 'success');
                      channelAntispamEditing = false;
                      loadChannelDetail(chatId);
                    })
                    .catch(function (e) {
                      showToast(e.message || 'Ошибка', 'error');
                    });
                },
              );
            });
          }
        }
        refreshIcons();
      })
      .catch(function (err) {
        if (err && err.message === 'auth') return;
        slot.innerHTML = '<p class="muted">Ошибка загрузки канала</p>';
      });
  }

  function lookupTgChatByKey(key) {
    var raw = String(key || '').trim().replace(/^@/, '');
    if (!raw) return null;
    return (
      (tgLinkedChatsCache || []).find(function (ch) {
        return String(ch.id) === raw || (ch.username && ch.username.replace(/^@/, '') === raw);
      }) || null
    );
  }

  function lookupMaxChatById(id) {
    var n = String(id || '').trim();
    if (!n) return null;
    return (maxLinkedChatsCache || []).find(function (ch) {
      return String(ch.id) === n;
    });
  }

  function tgChainTgDisplayName(chainOrKey) {
    var key = chainOrKey;
    var title = '';
    var sub = '';
    if (chainOrKey && typeof chainOrKey === 'object') {
      var c = chainOrKey;
      key = c.tg_channel_id || (c.tg_username ? '@' + c.tg_username : '');
      var hit = lookupTgChatByKey(key);
      title = hit ? hit.title : c.tg_username ? '@' + c.tg_username : String(key || 'Telegram');
      sub = c.tg_channel_id ? 'ID ' + c.tg_channel_id : hit && hit.username ? hit.username : '';
    } else {
      var ch = lookupTgChatByKey(key);
      title = ch ? ch.title : key ? (String(key).startsWith('-') ? 'Канал ' + key : '@' + key) : '—';
      sub = ch ? ch.username || 'ID ' + ch.id : '';
    }
    return { title: title, sub: sub };
  }

  function tgChainMaxDisplayName(chainOrId) {
    var id = chainOrId;
    var title = '';
    var sub = '';
    if (chainOrId && typeof chainOrId === 'object') {
      id = chainOrId.max_chat_id;
      title = chainOrId.max_title || String(id);
      sub = 'ID ' + id;
    } else {
      var ch = lookupMaxChatById(id);
      title = ch ? ch.title : id ? String(id) : '—';
      sub = id ? 'ID ' + id : '';
    }
    return { title: title, sub: sub };
  }

  function updateTgChainPairPreview(root) {
    var el = qs('#tc_pair_preview', root);
    if (!el) return;
    var tgRaw = readTelegramChannelPick('tc_tg_select', 'tc_tg_manual', root);
    var maxId = qs('#tc_max', root) ? qs('#tc_max', root).value : '';
    if (!tgRaw || !maxId) {
      el.className = 'tg-chain-pair-live is-empty';
      el.innerHTML =
        'Выберите <strong>канал Telegram</strong> (откуда) и <strong>канал MAX</strong> (куда публиковать посты).';
      return;
    }
    var tg = tgChainTgDisplayName(tgRaw);
    var mx = tgChainMaxDisplayName(maxId);
    el.className = 'tg-chain-pair-live';
    el.innerHTML =
      'Пара: <strong>' +
      esc(tg.title) +
      '</strong> → <strong>' +
      esc(mx.title) +
      '</strong>. Новые посты в Telegram сразу появятся в MAX.';
  }

  function readTagsFromWrap(wrap) {
    if (!wrap) return [];
    if (typeof wrap.__tagsGet === 'function') {
      return wrap.__tagsGet(true);
    }
    var tags = [];
    qsa('.tag', wrap).forEach(function (tg) {
      var text = '';
      for (var i = 0; i < tg.childNodes.length; i++) {
        var n = tg.childNodes[i];
        if (n.nodeType === 3) text += n.textContent || '';
        else if (n.nodeType === 1 && String(n.tagName || '').toUpperCase() !== 'BUTTON') {
          text += n.textContent || '';
        }
      }
      text = text.trim();
      if (text) tags.push(text);
    });
    var inp = qs('.tags-input', wrap);
    var pending = inp ? String(inp.value || '').trim() : '';
    if (pending && tags.indexOf(pending) === -1) tags.push(pending);
    return tags;
  }

  function updateTgChainCommentSyncVisibility(root) {
    var block = qs('#tc_comment_sync_block', root);
    if (!block) return;
    var row = qs('[data-toggle-key="forward_comments"]', root);
    var sw = row ? qs('.switch', row) : null;
    var on = sw && sw.classList.contains('on');
    block.classList.toggle('hidden', !on);
  }

  function tgChainDomId(chainId) {
    return String(chainId || '').replace(/-/g, '');
  }

  function buildCommentSyncMatchModeSelect(selectedMode, attrs) {
    var mode = selectedMode || 'contains';
    var attrStr = attrs ? ' ' + attrs : '';
    var modes = [
      { value: 'contains', label: 'Содержит фразу' },
      { value: 'equals', label: 'Точное совпадение (весь текст)' },
      { value: 'word', label: 'Отдельное слово' },
      { value: 'starts_with', label: 'Начинается с' },
      { value: 'ends_with', label: 'Заканчивается на' },
    ];
    var html =
      '<select class="input" data-chain-comment-match-mode' +
      attrStr +
      ' style="width:100%">';
    modes.forEach(function (m) {
      html +=
        '<option value="' +
        esc(m.value) +
        '"' +
        (mode === m.value ? ' selected' : '') +
        '>' +
        esc(m.label) +
        '</option>';
    });
    html += '</select>';
    return html;
  }

  function readCommentSyncMatchMode(root, selector) {
    var el = qs(selector || '[data-chain-comment-match-mode]', root);
    var value = el ? String(el.value || '').trim() : '';
    if (
      value === 'contains' ||
      value === 'equals' ||
      value === 'word' ||
      value === 'starts_with' ||
      value === 'ends_with'
    ) {
      return value;
    }
    return 'contains';
  }

  var commentSyncKeywordHelp =
    'Enter — добавить тег. Для одного слова можно задать свой режим префиксом: <code>=да</code> (точно), <code>#вопрос</code> (отдельное слово), <code>^привет</code> (начало), <code>$!</code> (конец), <code>~help</code> (содержит). Без слов обычные комментарии не переносятся.';

  function updateChainCardCommentSyncVisibility(card) {
    var sw = qs('[data-chain-comment-forward]', card);
    var fields = qs('[data-chain-comment-fields]', card);
    if (!sw || !fields) return;
    fields.classList.toggle('hidden', !sw.classList.contains('on'));
  }

  function renderTgChainCommentSettingsHtml(c, tgChats) {
    var sid = tgChainDomId(c.id);
    var kw = Array.isArray(c.comment_sync_keywords) ? c.comment_sync_keywords : [];
    var discVal = c.tg_discussion_chat_id ? String(c.tg_discussion_chat_id) : '';
    var html = '<details class="tg-chain-comment-settings">';
    html += '<summary>Комментарии TG → MAX';
    if (c.forward_comments) {
      html += ' · вкл';
      if (discVal) html += ' · чат ' + esc(discVal);
      if (kw.length) html += ' · ' + esc(String(kw.length)) + ' сл.';
      else html += ' · только админ';
    } else {
      html += ' · выкл';
    }
    html += '</summary>';
    html += '<div class="tg-chain-comment-sync">';
    html +=
      '<p class="muted text-sm" style="margin:0 0 10px;line-height:1.45">Обычные комментарии переносятся только при совпадении со словами. Комментарии админа — всегда, если он отвечает пользователю или если в MAX ещё нет комментариев.</p>';
    html +=
      '<label class="tg-chain-mini-toggle" style="margin-bottom:10px"><span>Синхронизировать комментарии</span><span class="switch' +
      (c.forward_comments ? ' on' : '') +
      '" data-chain-comment-forward role="switch" tabindex="0"></span></label>';
    html +=
      '<div data-chain-comment-fields' +
      (c.forward_comments ? '' : ' class="hidden"') +
      '>';
    var sendAsVal = c.tg_discussion_send_as === 'chat' ? 'chat' : 'channel';
    html +=
      '<div class="form-group"><label>От чьего имени в TG (MAX → TG)</label><p class="muted text-sm" style="margin:0 0 6px">Нужна MTProto user-сессия (блок выше на странице TG→MAX). «Чат» — как анонимный админ группы обсуждений.</p>';
    html +=
      '<select class="input" data-chain-discussion-send-as style="width:100%"><option value="channel"' +
      (sendAsVal === 'channel' ? ' selected' : '') +
      '>От имени канала</option><option value="chat"' +
      (sendAsVal === 'chat' ? ' selected' : '') +
      '>От имени чата обсуждений</option></select></div>';
    html +=
      '<div class="form-group"><label>Чат комментариев</label><p class="muted text-sm" style="margin:0 0 6px">Группа обсуждений. Пусто — linked chat канала.</p>';
    html +=
      buildTelegramChannelSelect('tc_disc_' + sid + '_select', tgChats, 'tc_disc_' + sid + '_manual', {
        adminOnly: true,
        groupsOnly: true,
        selectedValue: discVal,
      });
    html += '</div>';
    html +=
      '<div class="form-group"><label>Условие для слов</label><p class="muted text-sm" style="margin:0 0 6px">Как сравнивать каждое слово с текстом комментария. Префиксы в тегах переопределяют это для отдельных слов.</p>';
    html += buildCommentSyncMatchModeSelect(c.comment_sync_match_mode || 'contains');
    html += '</div>';
    html +=
      '<div class="form-group"><label>Слова для переноса</label><p class="muted text-sm" style="margin:0 0 6px">' +
      commentSyncKeywordHelp +
      '</p>';
    html += '<div class="tags-input-wrap" id="tc_disc_' + esc(sid) + '_kw"></div></div>';
    html += '</div>';
    html +=
      '<button type="button" class="btn btn-primary btn-sm mt-sm" data-chain-comment-save>Сохранить комментарии</button>';
    html += '</div></details>';
    return html;
  }

  function bindTgChainCommentSettings(card, chain) {
    var sid = tgChainDomId(chain.id);
    var kwWrap = qs('#tc_disc_' + sid + '_kw', card);
    if (kwWrap && kwWrap.getAttribute('data-bound-tags') !== '1') {
      bindTagsInput(kwWrap, chain.comment_sync_keywords || [], function () {});
      kwWrap.setAttribute('data-bound-tags', '1');
    }
    var fwdSw = qs('[data-chain-comment-forward]', card);
    if (fwdSw && fwdSw.getAttribute('data-bound-click') !== '1') {
      fwdSw.addEventListener('click', function (e) {
        e.stopPropagation();
        fwdSw.classList.toggle('on');
        updateChainCardCommentSyncVisibility(card);
      });
      fwdSw.setAttribute('data-bound-click', '1');
    }
    var saveBtn = qs('[data-chain-comment-save]', card);
    if (saveBtn && saveBtn.getAttribute('data-bound-click') !== '1') {
      saveBtn.addEventListener('click', function () {
        var patch = {
          forward_comments: !!(fwdSw && fwdSw.classList.contains('on')),
          comment_sync_keywords: readTagsFromWrap(kwWrap),
          comment_sync_match_mode: readCommentSyncMatchMode(card),
        };
        var discRaw = readTelegramChannelPick('tc_disc_' + sid + '_select', 'tc_disc_' + sid + '_manual', card);
        var sendAsEl = qs('[data-chain-discussion-send-as]', card);
        if (sendAsEl && (sendAsEl.value === 'channel' || sendAsEl.value === 'chat')) {
          patch.tg_discussion_send_as = sendAsEl.value;
        }
        if (discRaw) {
          patch.tg_discussion_chat_id = discRaw.replace(/^@/, '');
        } else if (chain.tg_discussion_chat_id) {
          patch.tg_discussion_chat_id = String(chain.tg_discussion_chat_id);
        } else {
          patch.tg_discussion_chat_id = null;
        }
        saveBtn.disabled = true;
        patchJson('/tg-chains/' + encodeURIComponent(chain.id), patch)
          .then(function () {
            showToast('Настройки комментариев сохранены', 'success');
            renderTgChains();
          })
          .catch(function (err) {
            showToast(err.message || 'Ошибка', 'error');
          })
          .finally(function () {
            saveBtn.disabled = false;
          });
      });
      saveBtn.setAttribute('data-bound-click', '1');
    }
  }

  function submitTgChainFromForm(root, onDone) {
    var chatId = Number(qs('#tc_max', root).value);
    var tgRaw = readTelegramChannelPick('tc_tg_select', 'tc_tg_manual', root);
    var tgKey = String(tgRaw || '').trim();
    var tokenEl = qs('#tc_token', root);
    var token = tokenEl ? String(tokenEl.value || '').trim() : '';
    var sw = readSwitches(root);
    if (!chatId || !tgKey) {
      showToast('Выберите канал Telegram и канал MAX', 'error');
      return;
    }
    var btn = qs('#tc_submit', root);
    if (btn) btn.disabled = true;
    var isNumeric = /^-?\d+$/.test(tgKey.replace(/^@/, ''));
    var payload = {
      max_chat_id: chatId,
      tg_channel: tgKey,
      forward_posts: sw.forward_posts !== false,
      forward_comments: !!sw.forward_comments,
      add_comments_button: sw.add_comments_button !== false,
      add_signature: !!sw.add_signature,
    };
    if (sw.forward_comments) {
      var discRaw = readTelegramChannelPick('tc_discussion_select', 'tc_discussion_manual', root);
      if (discRaw) payload.tg_discussion_chat_id = discRaw.replace(/^@/, '');
      var kwWrap = qs('#tc_comment_keywords', root);
      payload.comment_sync_keywords = readTagsFromWrap(kwWrap);
      payload.comment_sync_match_mode = readCommentSyncMatchMode(root);
    } else {
      payload.comment_sync_keywords = [];
    }
    if (!isNumeric) payload.tg_username = tgKey.replace(/^@/, '');
    if (token) payload.bot_token = token;
    postJson('/tg-chains', payload)
      .then(function () {
        showToast('Пересылка включена', 'success');
        if (onDone) onDone();
      })
      .catch(function (e) {
        showToast(e.message || 'Ошибка', 'error');
      })
      .finally(function () {
        if (btn) btn.disabled = false;
      });
  }

  function bindTgChainCard(card, chain) {
    var chainId = chain.id;
    var activeSw = qs('[data-chain-field="active"]', card);
    if (activeSw) {
      activeSw.addEventListener('click', function (e) {
        e.stopPropagation();
        var next = !activeSw.classList.contains('on');
        patchJson('/tg-chains/' + encodeURIComponent(chainId), { active: next })
          .then(function () {
            activeSw.classList.toggle('on', next);
            card.classList.toggle('is-paused', !next);
            var badge = qs('.chain-status-badge', card);
            if (badge) {
              badge.className = 'chain-status-badge chain-status-badge--' + (next ? 'active' : 'paused');
              badge.textContent = next ? 'Активна' : 'На паузе';
            }
            showToast(next ? 'Пересылка включена' : 'На паузе', 'success');
          })
          .catch(function (err) {
            showToast(err.message || 'Ошибка', 'error');
          });
      });
    }
    qsa('[data-chain-field]:not([data-chain-field="active"])', card).forEach(function (sw) {
      sw.addEventListener('click', function (e) {
        e.stopPropagation();
        var field = sw.getAttribute('data-chain-field');
        var next = !sw.classList.contains('on');
        var patch = {};
        patch[field] = next;
        patchJson('/tg-chains/' + encodeURIComponent(chainId), patch)
          .then(function () {
            sw.classList.toggle('on', next);
            showToast('Сохранено', 'success');
          })
          .catch(function (err) {
            showToast(err.message || 'Ошибка', 'error');
          });
      });
    });
    var del = qs('[data-del-chain]', card);
    if (del) {
      del.addEventListener('click', function () {
        showConfirm('Удалить эту цепочку?', 'Пересылка между каналами прекратится.', function () {
          deleteReq('/tg-chains/' + encodeURIComponent(chainId))
            .then(function () {
              showToast('Удалено', 'success');
              renderTgChains();
            })
            .catch(function (err) {
              showToast(err.message || 'Ошибка', 'error');
            });
        });
      });
    }
    bindTgChainCommentSettings(card, chain);
  }

  function renderTgChainCardHtml(c, tgChats) {
    var tg = tgChainTgDisplayName(c);
    var mx = tgChainMaxDisplayName(c);
    var shortId = String(c.id || '').slice(0, 8);
    var html =
      '<article class="chain-card tg-chain-card' +
      (c.active ? '' : ' is-paused') +
      '" data-chain-id="' +
      esc(c.id) +
      '">';
    html += '<header class="chain-card__header">';
    html +=
      '<span class="chain-status-badge chain-status-badge--' +
      (c.active ? 'active' : 'paused') +
      '">' +
      (c.active ? 'Активна' : 'На паузе') +
      '</span>';
    if (shortId) html += '<span class="chain-card__id" title="' + esc(c.id) + '">#' + esc(shortId) + '</span>';
    html += '</header>';
    html += '<div class="chain-card__flow">';
    html += '<div class="chain-card__node chain-card__node--tg">';
    html += '<span class="chain-card__platform-icon">TG</span>';
    html += '<div class="chain-card__node-info">';
    html += '<span class="chain-card__node-name" title="' + esc(tg.title) + '">' + esc(tg.title) + '</span>';
    if (tg.sub) html += '<span class="chain-card__node-id">' + esc(tg.sub) + '</span>';
    html += '</div></div>';
    html += '<div class="chain-card__connector"><i data-lucide="arrow-right"></i></div>';
    html += '<div class="chain-card__node chain-card__node--max">';
    html += '<span class="chain-card__platform-icon">MAX</span>';
    html += '<div class="chain-card__node-info">';
    html += '<span class="chain-card__node-name" title="' + esc(mx.title) + '">' + esc(mx.title) + '</span>';
    if (mx.sub) html += '<span class="chain-card__node-id">' + esc(mx.sub) + '</span>';
    html += '</div></div></div>';
    html += '<div class="chain-card__stats">';
    html +=
      '<span><i data-lucide="send"></i> Сегодня: <strong>' + esc(fmtNum(c.forwarded_today)) + '</strong></span>';
    if (c.forward_comments) {
      html += '<span><i data-lucide="message-circle"></i> Комментарии</span>';
    }
    if (c.add_signature) html += '<span><i data-lucide="pen-line"></i> Подпись TG</span>';
    if (c.errors_today) {
      html +=
        '<span class="is-error"><i data-lucide="alert-triangle"></i> Ошибок: ' +
        esc(fmtNum(c.errors_today)) +
        '</span>';
    }
    html += '</div>';
    html += renderTgChainCommentSettingsHtml(c, tgChats || []);
    html += '<footer class="chain-card__footer">';
    html += '<div class="chain-card__toggles">';
    html +=
      '<label class="tg-chain-mini-toggle"><span>Пересылка</span><span class="switch' +
      (c.active ? ' on' : '') +
      '" data-chain-field="active" role="switch" tabindex="0"></span></label>';
    html +=
      '<label class="tg-chain-mini-toggle"><span>Кнопка 💬</span><span class="switch' +
      (c.add_comments_button !== false ? ' on' : '') +
      '" data-chain-field="add_comments_button" role="switch" tabindex="0"></span></label>';
    html +=
      '<label class="tg-chain-mini-toggle"><span>Подпись TG</span><span class="switch' +
      (c.add_signature ? ' on' : '') +
      '" data-chain-field="add_signature" role="switch" tabindex="0"></span></label>';
    html += '</div>';
    html += '<div class="chain-card__actions-end">';
    html +=
      '<button type="button" class="btn btn-danger btn-sm" data-del-chain="' +
      esc(c.id) +
      '"><i data-lucide="trash-2"></i></button>';
    html += '</div></footer></article>';
    return html;
  }

  function bindTgChainSetupPage(main) {
    var tgSel = qs('#tc_tg_select', main);
    var maxSel = qs('#tc_max', main);
    var manual = qs('#tc_tg_manual', main);
    function onPickChange() {
      updateTgChainPairPreview(main);
      updateChainsWizardSteps(main);
    }
    if (tgSel && tgSel.getAttribute('data-bound-change') !== '1') {
      tgSel.addEventListener('change', onPickChange);
      tgSel.setAttribute('data-bound-change', '1');
    }
    if (maxSel && maxSel.getAttribute('data-bound-change') !== '1') {
      maxSel.addEventListener('change', onPickChange);
      maxSel.setAttribute('data-bound-change', '1');
    }
    if (manual && manual.getAttribute('data-bound-input') !== '1') {
      manual.addEventListener('input', onPickChange);
      manual.setAttribute('data-bound-input', '1');
    }
    var kwWrap = qs('#tc_comment_keywords', main);
    if (kwWrap && kwWrap.getAttribute('data-bound-tags') !== '1') {
      bindTagsInput(kwWrap, [], function () {});
      kwWrap.setAttribute('data-bound-tags', '1');
    }
    qsa('[data-toggle-key="forward_comments"] .switch', main).forEach(function (sw) {
      if (sw.getAttribute('data-bound-comment-sync') === '1') return;
      sw.addEventListener('click', function () {
        window.setTimeout(function () {
          updateTgChainCommentSyncVisibility(main);
        }, 0);
      });
      sw.setAttribute('data-bound-comment-sync', '1');
    });
    updateTgChainCommentSyncVisibility(main);
    var refreshMax = qs('#tc_refresh_max', main);
    if (refreshMax && refreshMax.getAttribute('data-bound-click') !== '1') {
      refreshMax.addEventListener('click', function () {
        refreshMax.disabled = true;
        fetchMaxLinkedChannels(true)
          .then(function (data) {
            var sel = qs('#tc_max', main);
            if (sel) sel.innerHTML = buildMaxChannelSelectOptions(data.channels || [], { adminOnly: true });
            updateTgChainPairPreview(main);
            showToast((data.channels || []).length ? 'MAX обновлён' : 'Каналы не найдены', 'info');
          })
          .catch(function (e) {
            showToast(e.message || 'Ошибка', 'error');
          })
          .finally(function () {
            refreshMax.disabled = false;
            refreshIcons();
          });
      });
      refreshMax.setAttribute('data-bound-click', '1');
    }
    var refreshTg = qs('#tc_refresh_tg', main);
    if (refreshTg && refreshTg.getAttribute('data-bound-click') !== '1') {
      refreshTg.addEventListener('click', function () {
        refreshTg.disabled = true;
        fetchTelegramLinkedChats(true)
          .then(function (data) {
            var wrap = qs('#tc_tg_wrap', main);
            if (wrap) {
              wrap.innerHTML =
                '<div class="flex-between" style="align-items:center;gap:8px;margin-bottom:6px"><label style="margin:0">① Канал Telegram — откуда</label><button type="button" class="btn btn-ghost btn-sm" id="tc_refresh_tg"><i data-lucide="refresh-cw"></i> Обновить</button></div>' +
                buildTelegramChannelSelect('tc_tg_select', data.channels || [], 'tc_tg_manual', { adminOnly: true });
              bindTgChainSetupPage(main);
            }
            var discSel = qs('#tc_discussion_select', main);
            if (discSel) {
              var frag = document.createElement('div');
              frag.innerHTML = buildTelegramChannelSelect(
                'tc_discussion_select',
                data.channels || [],
                'tc_discussion_manual',
                { adminOnly: true, groupsOnly: true },
              );
              var newSel = qs('#tc_discussion_select', frag);
              if (newSel) discSel.innerHTML = newSel.innerHTML;
            }
            updateTgChainPairPreview(main);
            showToast((data.channels || []).length ? 'Telegram обновлён' : 'Чаты не найдены', 'info');
          })
          .catch(function (e) {
            showToast(e.message || 'Ошибка', 'error');
          })
          .finally(function () {
            refreshTg.disabled = false;
            refreshIcons();
          });
      });
      refreshTg.setAttribute('data-bound-click', '1');
    }
    var submit = qs('#tc_submit', main);
    if (submit && submit.getAttribute('data-bound-click') !== '1') {
      submit.addEventListener('click', function () {
        submitTgChainFromForm(main, function () {
          renderTgChains();
        });
      });
      submit.setAttribute('data-bound-click', '1');
    }
    bindToggleRows(main, null);
    updateTgChainPairPreview(main);
    updateChainsWizardSteps(main);
  }

  function renderTgChains() {
    var main = qs('#mainContent');
    if (!main) return;
    main.innerHTML = skeletonPage();
    ensureIntegrationsCache().then(function () {
      if (chainsPlatformTab === 'vk') {
        renderVkChainsPage(main);
        return;
      }
      renderTgChainsPage(main);
    });
  }

  function renderTgChainsPage(main) {
    Promise.all([
      getJson('/tg-chains'),
      getJson('/vk-chains').catch(function () {
        return { chains: [] };
      }),
      fetchMaxLinkedChannels(false).catch(function () {
        return { channels: maxLinkedChatsCache };
      }),
      fetchTelegramLinkedChats(false).catch(function () {
        return { channels: tgLinkedChatsCache };
      }),
    ])
      .then(function (bundle) {
        if (currentRoute !== 'tgchains' || chainsPlatformTab !== 'tg') return;
        var data = bundle[0];
        var vkData = bundle[1];
        var maxChannels = bundle[2].channels || maxLinkedChatsCache || [];
        var tgChats = bundle[3].channels || tgLinkedChatsCache || [];
        var chains = data.chains || [];
        var st = data.stats || {};
        var tgInt = integrationsCache.find(function (i) {
          return i.platform === 'telegram' && i.status === 'connected';
        });
        var filtered = filterChainsList(chains, 'tg');
        if (!chains.length) chainsWizardCollapsed = false;

        var html = '<div class="chains-hub tg-chains-page">';
        html += renderChainsPageHead('tg', st);
        html += renderChainsPlatformTabs('tg', {
          tg: chains.length,
          vk: (vkData.chains || []).length,
        });
        html += renderTelegramConnectBanner();
        html += '<div class="chains-layout">';

        html += renderChainsWizardPanelHead('Новая цепочка', 'plus-circle');
        html += '<div class="chains-wizard-steps">';
        html += '<div class="chains-wizard-step" data-wizard-step="1">① Telegram</div>';
        html += '<div class="chains-wizard-step" data-wizard-step="2">② MAX</div>';
        html += '<div class="chains-wizard-step" data-wizard-step="3">③ Опции</div>';
        html += '</div>';
        html += renderChainsRequirementsTg();
        html +=
          '<details class="chains-mtproto-fold"><summary>MTProto — синхронизация комментариев</summary>';
        html += buildMtprotoPanelHtml().replace('class="card-like mb-md mtproto-panel"', 'class="mtproto-panel"');
        html += '</details>';
        html += '<div class="forwarding-add-form forwarding-add-form--picks">';
        html +=
          '<div class="form-group" id="tc_tg_wrap"><div class="flex-between" style="align-items:center;gap:8px;margin-bottom:6px"><label style="margin:0">Канал Telegram — откуда</label><button type="button" class="btn btn-ghost btn-sm" id="tc_refresh_tg"><i data-lucide="refresh-cw"></i></button></div>';
        html += buildTelegramChannelSelect('tc_tg_select', tgChats, 'tc_tg_manual', { adminOnly: true }) + '</div>';
        html +=
          '<div class="form-group"><div class="flex-between" style="align-items:center;gap:8px;margin-bottom:6px"><label style="margin:0">Канал MAX — куда</label><button type="button" class="btn btn-ghost btn-sm" id="tc_refresh_max"><i data-lucide="refresh-cw"></i></button></div>';
        html += '<select class="select" id="tc_max">' + buildMaxChannelSelectOptions(maxChannels, { adminOnly: true }) + '</select></div>';
        html += '<div id="tc_pair_preview" class="tg-chain-pair-live is-empty"></div>';
        html += '<div id="tcToggles">';
        html += toggleRow('forward_posts', 'Пересылать посты', 'Новые публикации в TG → MAX', true);
        html += toggleRow('add_comments_button', 'Кнопка «Комментарии» в MAX', '', true);
        html += toggleRow('forward_comments', 'Синхронизация комментариев', 'MAX ↔ Telegram (обсуждения)', true);
        html += '</div>';
        html += '<details class="tg-chain-advanced"><summary>Дополнительно</summary><div style="margin-top:10px">';
        html += toggleRow('add_signature', 'Подпись «— TG»', '', false);
        html += '</div></details>';
        html += '<div id="tc_comment_sync_block" class="tg-chain-comment-sync hidden">';
        html +=
          '<p class="muted text-sm" style="margin:0 0 10px;line-height:1.45">Обычные комментарии переносятся только при совпадении со словами ниже. Комментарии админа — всегда, если он отвечает пользователю или если в MAX ещё нет комментариев.</p>';
        html +=
          '<div class="form-group"><label>Чат комментариев Telegram</label><p class="muted text-sm" style="margin:0 0 6px">Группа обсуждений канала. Если не указать — берётся linked chat канала.</p>';
        html +=
          buildTelegramChannelSelect('tc_discussion_select', tgChats, 'tc_discussion_manual', {
            adminOnly: true,
            groupsOnly: true,
          }) + '</div>';
        html +=
          '<div class="form-group"><label>Условие для слов</label><p class="muted text-sm" style="margin:0 0 6px">Как сравнивать слова с текстом комментария. Префиксы в тегах переопределяют режим для отдельных слов.</p>';
        html += buildCommentSyncMatchModeSelect('contains');
        html += '</div>';
        html +=
          '<div class="form-group"><label>Слова для переноса</label><p class="muted text-sm" style="margin:0 0 6px">' +
          commentSyncKeywordHelp +
          '</p>';
        html += '<div class="tags-input-wrap" id="tc_comment_keywords"></div></div>';
        html += '</div>';
        if (!tgInt) {
          html +=
            '<div class="form-group mt-sm"><label>Токен бота Telegram</label><input class="input mono" id="tc_token" type="password" placeholder="Или подключите в «Интеграции»"/></div>';
        }
        html += '<div class="forwarding-add-form-actions" style="margin-top:14px">';
        html += '<button type="button" class="btn btn-primary btn-block" id="tc_submit"><i data-lucide="zap"></i> Включить пересылку</button>';
        html += '</div></div></div></section>';

        html += '<section class="chains-panel chains-panel--list">';
        html += '<div class="chains-panel-head"><h3><i data-lucide="layers"></i> Настроенные пары</h3></div>';
        html += '<div class="chains-panel-body">';
        html += renderChainsToolbar(filtered.length, chains.length);
        html += '<div class="chains-list-grid">';
        if (filtered.length) {
          filtered.forEach(function (c) {
            html += renderTgChainCardHtml(c, tgChats);
          });
        } else {
          html += renderChainsEmptyState('tg', chains.length > 0);
        }
        html += '</div></div></section>';

        html += '</div></div>';
        main.innerHTML = html;
        bindChainsPlatformTabs(main);
        bindRouteJumpButtons(main);
        bindChainsListToolbar(main, 'tg', chains);
        bindMtprotoPanel(main);
        refreshMtprotoPanel(main);
        qsa('.tg-chain-card', main).forEach(function (card) {
          var chainId = card.getAttribute('data-chain-id');
          var chain = chains.find(function (c) {
            return c.id === chainId;
          });
          if (chain) bindTgChainCard(card, chain);
        });
        bindTgChainSetupPage(main);
        refreshIcons();
      })
      .catch(function (err) {
        if (err && err.message === 'auth') return;
        main.innerHTML = '<p class="muted">Ошибка: ' + esc(err.message || '') + '</p>';
      });
  }

  /** Превью одного выбранного сообщества VK (после резолвинга). */
  function renderVkGroupPreview(g, compact) {
    var url = g.url || ('https://vk.com/' + (g.screenName || ('club' + g.id)));
    var html = '<div class="vk-group-preview' + (compact ? ' vk-group-preview--compact' : '') + '">';
    if (g.photo) html += '<img src="' + esc(g.photo) + '" class="vk-group-avatar" alt=""/>';
    html += '<div class="vk-group-preview__info">';
    html += '<span class="vk-group-preview__name">' + esc(g.name || g.id) + '</span>';
    html += '<a href="' + esc(url) + '" target="_blank" class="vk-group-preview__url">' + esc(url.replace('https://', '')) + '</a>';
    html += '</div>';
    html += '<i data-lucide="check-circle" class="vk-group-preview__check"></i>';
    html += '</div>';
    return html;
  }

  /** Один элемент списка сообществ — с чекбоксом для мульти-выбора. */
  function renderVkGroupPickerItem(g) {
    var url = g.url || ('https://vk.com/' + (g.screenName || ('club' + g.id)));
    return (
      '<label class="vk-group-item" data-pick-vk-group="' + esc(g.id) + '"' +
      ' data-vk-name="' + esc(g.name || '') + '" data-vk-screen="' + esc(g.screenName || '') +
      '" data-vk-url="' + esc(url) + '" data-vk-photo="' + esc(g.photo || '') + '">' +
      '<input type="checkbox" class="vk-group-item__cb" value="' + esc(g.id) + '"/>' +
      (g.photo ? '<img src="' + esc(g.photo) + '" class="vk-group-avatar" alt=""/>' : '<span class="vk-group-avatar vk-group-avatar--empty">VK</span>') +
      '<span class="vk-group-item__info">' +
      '<span class="vk-group-item__name">' + esc(g.name || g.id) + '</span>' +
      '<span class="vk-group-item__url">' + esc(url.replace('https://', '')) + '</span>' +
      '</span>' +
      '<i data-lucide="check" class="vk-group-item__check"></i>' +
      '</label>'
    );
  }

  function getVkTokenFromForm(root, vkInt) {
    var tokenEl = qs('#vc_token', root);
    var token = tokenEl ? String(tokenEl.value || '').trim() : '';
    if (!token && vkInt && vkInt.token) token = String(vkInt.token).trim();
    return token || null;
  }

  /** Привязывает логику пикера сообществ VK с поддержкой мульти-выбора. */
  function bindVkCommunityPicker(root, vkInt) {
    var resolveBtn = qs('#vc_resolve_btn', root);
    var loadGroupsBtn = qs('#vc_load_groups_btn', root);
    var communityInput = qs('#vc_community_input', root);
    var resultEl = qs('#vc_community_result', root);
    var listEl = qs('#vc_groups_list', root);
    var groupIdHidden = qs('#vc_group_id', root);
    var multiBarEl = qs('#vc_multi_bar', root);

    // --- Обновляет плашку "Выбрано N сообществ" ---
    function refreshMultiBar() {
      if (!multiBarEl || !listEl) return;
      var checked = qsa('.vk-group-item__cb:checked', listEl);
      if (checked.length > 1) {
        multiBarEl.innerHTML =
          '<div class="vk-multi-bar">' +
          '<span>Выбрано сообществ: <strong>' + checked.length + '</strong></span>' +
          '<button type="button" class="btn btn-primary btn-sm" id="vc_multi_submit">' +
          '<i data-lucide="zap"></i> Создать ' + checked.length + ' связки</button>' +
          '</div>';
        refreshIcons();
        var multiBtn = qs('#vc_multi_submit', multiBarEl);
        if (multiBtn) {
          multiBtn.addEventListener('click', function () {
            submitVkChainsMulti(root, vkInt);
          });
        }
      } else {
        multiBarEl.innerHTML = '';
      }
    }

    // --- Выбор одиночного сообщества (через "Найти") ---
    function selectSingleGroup(g) {
      if (groupIdHidden) groupIdHidden.value = String(g.id || '');
      if (resultEl) { resultEl.innerHTML = renderVkGroupPreview(g, true); refreshIcons(); }
      // Снимаем все чекбоксы в списке при ручном резолве
      qsa('.vk-group-item__cb', listEl || root).forEach(function (cb) { cb.checked = false; });
      qsa('[data-pick-vk-group]', listEl || root).forEach(function (item) { item.classList.remove('is-selected'); });
      if (multiBarEl) multiBarEl.innerHTML = '';
    }

    if (resolveBtn) {
      resolveBtn.addEventListener('click', function () {
        var val = communityInput ? String(communityInput.value || '').trim() : '';
        if (!val) { showToast('Введите ссылку, username или ID', 'error'); return; }
        var token = getVkTokenFromForm(root, vkInt);
        if (!token) { showToast('Сначала укажите токен VK или подключите VK в «Интеграциях»', 'error'); return; }
        resolveBtn.disabled = true;
        resolveBtn.textContent = '…';
        postJson('/vk-resolve-group', { input: val, vk_token: token })
          .then(function (res) {
            if (listEl) listEl.innerHTML = '';
            selectSingleGroup(res.group);
          })
          .catch(function (e) { showToast(e.message || 'Сообщество не найдено', 'error'); })
          .finally(function () { resolveBtn.disabled = false; resolveBtn.textContent = 'Найти'; });
      });
      if (communityInput) {
        communityInput.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); resolveBtn.click(); }
        });
      }
    }

    if (loadGroupsBtn) {
      loadGroupsBtn.addEventListener('click', function () {
        var token = getVkTokenFromForm(root, vkInt);
        if (!token) { showToast('Сначала укажите токен VK или подключите VK в «Интеграциях»', 'error'); return; }
        loadGroupsBtn.disabled = true;
        loadGroupsBtn.innerHTML = '<i data-lucide="loader"></i> Загрузка…';
        getJson('/vk-groups?token=' + encodeURIComponent(token))
          .then(function (res) {
            var groups = res.groups || [];
            if (resultEl) resultEl.innerHTML = '';
            if (groupIdHidden) groupIdHidden.value = '';
            if (!groups.length) {
              if (listEl) listEl.innerHTML = '<p class="muted" style="padding:8px 0">Сообществ не найдено. Убедитесь, что токен имеет права администратора.</p>';
              return;
            }
            var hint = groups.length > 1
              ? '<p class="form-hint" style="margin-bottom:6px">Отметьте одно или несколько сообществ.</p>'
              : '';
            var html = hint + '<div class="vk-groups-picker">';
            groups.forEach(function (g) { html += renderVkGroupPickerItem(g); });
            html += '</div>';
            if (listEl) listEl.innerHTML = html;
            // Обработка чекбоксов
            qsa('.vk-group-item', listEl).forEach(function (item) {
              var cb = qs('.vk-group-item__cb', item);
              if (!cb) return;
              item.addEventListener('click', function (e) {
                // click на label уже переключает cb; обновляем стиль и плашку
                setTimeout(function () {
                  item.classList.toggle('is-selected', cb.checked);
                  // Если выбрано ровно одно — пишем в скрытый input (для совместимости с main submit)
                  var allChecked = qsa('.vk-group-item__cb:checked', listEl);
                  if (allChecked.length === 1) {
                    if (groupIdHidden) groupIdHidden.value = allChecked[0].value;
                    if (resultEl) {
                      var parentItem = allChecked[0].closest ? allChecked[0].closest('[data-pick-vk-group]') : null;
                      if (parentItem) {
                        var url = parentItem.getAttribute('data-vk-url') || '';
                        resultEl.innerHTML = renderVkGroupPreview({
                          id: allChecked[0].value,
                          name: parentItem.getAttribute('data-vk-name') || '',
                          screenName: parentItem.getAttribute('data-vk-screen') || '',
                          url: url,
                          photo: parentItem.getAttribute('data-vk-photo') || '',
                        }, true);
                        refreshIcons();
                      }
                    }
                  } else {
                    if (groupIdHidden) groupIdHidden.value = '';
                    if (resultEl) resultEl.innerHTML = '';
                  }
                  refreshMultiBar();
                }, 0);
              });
            });
            refreshIcons();
          })
          .catch(function (e) { showToast(e.message || 'Ошибка загрузки', 'error'); })
          .finally(function () {
            loadGroupsBtn.disabled = false;
            loadGroupsBtn.innerHTML = '<i data-lucide="list"></i> Мои сообщества';
            refreshIcons();
          });
      });
    }
  }

  /** Пакетное создание связок для всех отмеченных сообществ. */
  function submitVkChainsMulti(root, vkInt) {
    var maxId = Number(qs('#vc_max', root) ? qs('#vc_max', root).value : '');
    if (!maxId) { showToast('Выберите канал MAX', 'error'); return; }
    var sw = readSwitches(root);
    var tokenEl = qs('#vc_token', root);
    var listEl = qs('#vc_groups_list', root);
    var checked = listEl ? qsa('.vk-group-item__cb:checked', listEl) : [];
    if (!checked.length) { showToast('Отметьте хотя бы одно сообщество', 'error'); return; }

    var btn = qs('#vc_multi_submit', root);
    if (btn) btn.disabled = true;

    var tasks = Array.prototype.slice.call(checked).map(function (cb) {
      var body = {
        max_chat_id: maxId,
        vk_group_id: cb.value,
        forward_posts: sw.forward_posts !== false,
        sync_comments: !!sw.sync_comments,
      };
      if (tokenEl && tokenEl.value.trim()) body.vk_token = tokenEl.value.trim();
      return postJson('/vk-chains', body);
    });

    Promise.allSettled(tasks).then(function (results) {
      var ok = results.filter(function (r) { return r.status === 'fulfilled'; }).length;
      var fail = results.length - ok;
      if (ok) showToast('Создано связок: ' + ok + (fail ? (', ошибок: ' + fail) : ''), ok === results.length ? 'success' : 'info');
      else showToast('Не удалось создать связки', 'error');
      renderTgChains();
    });
  }

  function renderVkConnectBanner() {
    var vkInt = integrationsCache.find(function (i) {
      return i.platform === 'vk' && i.status === 'connected';
    });
    if (vkInt) return '';
    return (
      '<div class="chains-connect-banner">' +
      '<span>VK не подключён — укажите токен сообщества вручную или подключите в «Интеграции».</span>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-route-jump="integrations">Подключить VK</button>' +
      '</div>'
    );
  }

  function renderVkChainCardHtml(c) {
    var mx = tgChainMaxDisplayName(c);
    var shortId = String(c.id || '').slice(0, 8);
    var html =
      '<article class="chain-card tg-chain-card' +
      (c.active ? '' : ' is-paused') +
      '" data-vk-chain-id="' +
      esc(c.id) +
      '">';
    html += '<header class="chain-card__header">';
    html +=
      '<span class="chain-status-badge chain-status-badge--' +
      (c.active ? 'active' : 'paused') +
      '">' +
      (c.active ? 'Активна' : 'На паузе') +
      '</span>';
    if (shortId) html += '<span class="chain-card__id" title="' + esc(c.id) + '">#' + esc(shortId) + '</span>';
    html += '</header>';
    html += '<div class="chain-card__flow">';
    html += '<div class="chain-card__node chain-card__node--max">';
    html += '<span class="chain-card__platform-icon">MAX</span>';
    html += '<div class="chain-card__node-info">';
    html += '<span class="chain-card__node-name">' + esc(mx.title) + '</span>';
    if (mx.sub) html += '<span class="chain-card__node-id">' + esc(mx.sub) + '</span>';
    html += '</div></div>';
    html += '<div class="chain-card__connector"><i data-lucide="arrow-right"></i></div>';
    html += '<div class="chain-card__node chain-card__node--vk">';
    html += '<span class="chain-card__platform-icon">VK</span>';
    html += '<div class="chain-card__node-info">';
    var vkDisplayName = c.vk_name || ('Сообщество ' + esc(c.vk_group_id || '—'));
    var vkUrl = c.vk_screen_name ? 'vk.com/' + c.vk_screen_name : ('vk.com/club' + (c.vk_group_id || ''));
    html += '<span class="chain-card__node-name">' + esc(vkDisplayName) + '</span>';
    html += '<a href="https://' + esc(vkUrl) + '" target="_blank" class="chain-card__node-id chain-card__node-link">' + esc(vkUrl) + '</a>';
    html += '</div></div></div>';
    html += '<div class="chain-card__stats">';
    html +=
      '<span><i data-lucide="send"></i> Сегодня: <strong>' + esc(fmtNum(c.forwarded_today)) + '</strong></span>';
    if (c.sync_comments) html += '<span><i data-lucide="message-circle"></i> Комментарии VK↔MAX</span>';
    if (c.errors_today) {
      html +=
        '<span class="is-error"><i data-lucide="alert-triangle"></i> Ошибок: ' +
        esc(fmtNum(c.errors_today)) +
        '</span>';
    }
    html += '</div>';
    html += '<footer class="chain-card__footer">';
    html += '<div class="chain-card__toggles">';
    html +=
      '<label class="tg-chain-mini-toggle"><span>Посты</span><span class="switch' +
      (c.forward_posts !== false ? ' on' : '') +
      '" data-vk-chain-field="forward_posts" role="switch" tabindex="0"></span></label>';
    html +=
      '<label class="tg-chain-mini-toggle"><span>Комментарии</span><span class="switch' +
      (c.sync_comments ? ' on' : '') +
      '" data-vk-chain-field="sync_comments" role="switch" tabindex="0"></span></label>';
    html +=
      '<label class="tg-chain-mini-toggle"><span>Пересылка</span><span class="switch' +
      (c.active ? ' on' : '') +
      '" data-vk-chain-field="active" role="switch" tabindex="0"></span></label>';
    html += '</div>';
    html += '<div class="chain-card__actions-end">';
    html +=
      '<button type="button" class="btn btn-danger btn-sm" data-del-vk-chain><i data-lucide="trash-2"></i></button>';
    html += '</div></footer></article>';
    return html;
  }

  function bindVkChainCard(card, chain) {
    var chainId = chain.id;
    qsa('[data-vk-chain-field]', card).forEach(function (sw) {
      sw.addEventListener('click', function (e) {
        e.stopPropagation();
        var field = sw.getAttribute('data-vk-chain-field');
        var next = !sw.classList.contains('on');
        var patch = {};
        patch[field] = next;
        patchJson('/vk-chains/' + encodeURIComponent(chainId), patch)
          .then(function () {
            sw.classList.toggle('on', next);
            if (field === 'active') {
              card.classList.toggle('is-paused', !next);
              var badge = qs('.chain-status-badge', card);
              if (badge) {
                badge.className = 'chain-status-badge chain-status-badge--' + (next ? 'active' : 'paused');
                badge.textContent = next ? 'Активна' : 'На паузе';
              }
            }
            showToast('Сохранено', 'success');
          })
          .catch(function (err) {
            showToast(err.message || 'Ошибка', 'error');
          });
      });
    });
    var del = qs('[data-del-vk-chain]', card);
    if (del) {
      del.addEventListener('click', function () {
        showConfirm('Удалить VK-связку?', 'Публикация в VK для этого канала прекратится.', function () {
          deleteReq('/vk-chains/' + encodeURIComponent(chainId))
            .then(function () {
              showToast('Удалено', 'success');
              renderTgChains();
            })
            .catch(function (err) {
              showToast(err.message || 'Ошибка', 'error');
            });
        });
      });
    }
  }

  function submitVkChainFromForm(root) {
    var maxId = Number(qs('#vc_max', root) ? qs('#vc_max', root).value : '');
    var groupIdEl = qs('#vc_group_id', root);
    var tokenEl = qs('#vc_token', root);
    var vkGroup = groupIdEl ? String(groupIdEl.value || '').trim().replace(/^-/, '') : '';
    var vkToken = tokenEl ? String(tokenEl.value || '').trim() : '';
    var vkInt = integrationsCache.find(function (i) {
      return i.platform === 'vk' && i.status === 'connected';
    });
    // Токен берём из формы или из сохранённой интеграции (сервер тоже это сделает, но проверяем на клиенте)
    if (!vkToken && vkInt && vkInt.token) vkToken = String(vkInt.token).trim();
    var sw = readSwitches(root);
    if (!maxId) {
      showToast('Выберите канал MAX', 'error');
      return;
    }
    if (!vkGroup) {
      showToast('Выберите сообщество ВКонтакте: введите ссылку и нажмите «Найти» или загрузите список', 'error');
      return;
    }
    if (!vkToken) {
      showToast('Укажите токен VK или подключите VK в «Интеграциях»', 'error');
      return;
    }
    var btn = qs('#vc_submit', root);
    if (btn) btn.disabled = true;
    var body = {
      max_chat_id: maxId,
      vk_group_id: vkGroup,
      forward_posts: sw.forward_posts !== false,
      sync_comments: !!sw.sync_comments,
    };
    // Передаём токен только если он явно введён (иначе сервер возьмёт из интеграции)
    if (tokenEl && tokenEl.value.trim()) body.vk_token = tokenEl.value.trim();
    postJson('/vk-chains', body)
      .then(function () {
        showToast('VK-связка создана', 'success');
        renderTgChains();
      })
      .catch(function (e) {
        showToast(e.message || 'Ошибка', 'error');
      })
      .finally(function () {
        if (btn) btn.disabled = false;
      });
  }

  function renderVkChainsPage(main) {
    Promise.all([
      getJson('/vk-chains'),
      getJson('/tg-chains').catch(function () {
        return { chains: [] };
      }),
      fetchMaxLinkedChannels(false).catch(function () {
        return { channels: maxLinkedChatsCache };
      }),
    ])
      .then(function (bundle) {
        if (currentRoute !== 'tgchains' || chainsPlatformTab !== 'vk') return;
        var data = bundle[0];
        var tgData = bundle[1];
        var maxChannels = bundle[2].channels || maxLinkedChatsCache || [];
        var chains = data.chains || [];
        var st = data.stats || {};
        var vkInt = integrationsCache.find(function (i) {
          return i.platform === 'vk' && i.status === 'connected';
        });
        var filtered = filterChainsList(chains, 'vk');
        if (!chains.length) chainsWizardCollapsed = false;

        var html = '<div class="chains-hub tg-chains-page">';
        html += renderChainsPageHead('vk', st);
        html += renderChainsPlatformTabs('vk', {
          tg: (tgData.chains || []).length,
          vk: chains.length,
        });
        html += renderVkConnectBanner();
        html += '<div class="chains-layout">';

        html += renderChainsWizardPanelHead('Новая связка', 'plus-circle');
        html +=
          '<div class="chains-requirements"><strong>Требования</strong><ul>' +
          '<li>Бот MAX — админ в исходном канале</li>' +
          '<li>Токен VK с правами <code>wall</code>, <code>photos</code>, <code>comments</code></li>' +
          '</ul></div>';
        html += '<div class="forwarding-add-form forwarding-add-form--picks">';
        html +=
          '<div class="form-group"><div class="flex-between" style="align-items:center;gap:8px;margin-bottom:6px"><label style="margin:0">Канал MAX — источник</label><button type="button" class="btn btn-ghost btn-sm" id="vc_refresh_max"><i data-lucide="refresh-cw"></i></button></div>';
        html +=
          '<select class="select" id="vc_max">' +
          buildMaxChannelSelectOptions(maxChannels, { adminOnly: true }) +
          '</select></div>';
        // ── Токен (если VK не подключён глобально) ──
        if (!vkInt) {
          html +=
            '<div class="form-group">' +
            '<label>Токен сообщества VK <span class="label-hint">— права: wall, comments</span></label>' +
            '<input class="input mono" id="vc_token" type="password" placeholder="vk1.a.xxxxxxxx"/>' +
            '</div>';
        } else {
          html += '<input type="hidden" id="vc_token" value=""/>';
        }

        // ── Выбор сообщества ──
        html += '<div class="form-group">';
        html += '<div class="flex-between" style="align-items:center;gap:8px;margin-bottom:6px">';
        html += '<label style="margin:0">Сообщество ВКонтакте</label>';
        html += '<button type="button" class="btn btn-ghost btn-sm" id="vc_load_groups_btn"><i data-lucide="list"></i> Мои сообщества</button>';
        html += '</div>';
        html += '<div style="display:flex;gap:8px">';
        html += '<input class="input" id="vc_community_input" placeholder="vk.com/ostrovskidok  или  12345678" style="flex:1"/>';
        html += '<button type="button" class="btn btn-secondary btn-sm" id="vc_resolve_btn" style="white-space:nowrap">Найти</button>';
        html += '</div>';
        html += '<p class="form-hint">Введите ссылку, username или числовой ID сообщества и нажмите «Найти».</p>';
        html += '<div id="vc_community_result" style="margin-top:8px"></div>';
        html += '<div id="vc_groups_list" style="margin-top:8px"></div>';
        html += '<div id="vc_multi_bar"></div>';
        html += '<input type="hidden" id="vc_group_id"/>';
        html += '</div>';
        html += '<div id="vcToggles">';
        html += toggleRow('forward_posts', 'Публиковать посты в VK', '', true);
        html += toggleRow('sync_comments', 'Синхронизировать комментарии', 'VK ↔ MAX miniapp', false);
        html += '</div>';
        html += '<div class="forwarding-add-form-actions" style="margin-top:14px">';
        html +=
          '<button type="button" class="btn btn-primary btn-block" id="vc_submit"><i data-lucide="zap"></i> Создать связку</button>';
        html += '</div></div></div></section>';

        html += '<section class="chains-panel chains-panel--list">';
        html += '<div class="chains-panel-head"><h3><i data-lucide="layers"></i> Настроенные связки</h3></div>';
        html += '<div class="chains-panel-body">';
        html += renderChainsToolbar(filtered.length, chains.length);
        html += '<div class="chains-list-grid">';
        if (filtered.length) {
          filtered.forEach(function (c) {
            html += renderVkChainCardHtml(c);
          });
        } else {
          html += renderChainsEmptyState('vk', chains.length > 0);
        }
        html += '</div></div></section>';

        html += '</div></div>';
        main.innerHTML = html;
        bindChainsPlatformTabs(main);
        bindRouteJumpButtons(main);
        bindChainsListToolbar(main, 'vk', chains);
        var refreshMax = qs('#vc_refresh_max', main);
        if (refreshMax) {
          refreshMax.addEventListener('click', function () {
            fetchMaxLinkedChannels(true)
              .then(function (data) {
                var sel = qs('#vc_max', main);
                if (sel) sel.innerHTML = buildMaxChannelSelectOptions(data.channels || [], { adminOnly: true });
                showToast((data.channels || []).length ? 'MAX обновлён' : 'Каналы не найдены', 'info');
                refreshIcons();
              })
              .catch(function (e) {
                showToast(e.message || 'Ошибка', 'error');
              });
          });
        }
        bindVkCommunityPicker(main, vkInt || null);
        var submit = qs('#vc_submit', main);
        if (submit) submit.addEventListener('click', function () { submitVkChainFromForm(main); });
        bindToggleRows(main, null);
        qsa('[data-vk-chain-id]', main).forEach(function (card) {
          var chainId = card.getAttribute('data-vk-chain-id');
          var chain = chains.find(function (c) { return c.id === chainId; });
          if (chain) bindVkChainCard(card, chain);
        });
        refreshIcons();
      })
      .catch(function (err) {
        if (err && err.message === 'auth') return;
        main.innerHTML = '<p class="muted">Ошибка: ' + esc(err.message || '') + '</p>';
      });
  }

  function buildMaxChannelSelectOptions(channels, options) {
    options = options || {};
    var list = channels || [];
    if (options.adminOnly) {
      var adminOnly = list.filter(function (ch) {
        return ch.botIsAdmin === true;
      });
      if (adminOnly.length) list = adminOnly;
    }
    if (!list.length) {
      return '<option value="">— нет каналов MAX (загрузите в «Интеграции») —</option>';
    }
    var opts = '<option value="">— выберите канал MAX —</option>';
    list.forEach(function (ch) {
      var label = (ch.title || 'Канал') + ' · ID ' + ch.id;
      if (ch.botIsAdmin) label += ' · админ';
      opts += '<option value="' + esc(String(ch.id)) + '">' + esc(label) + '</option>';
    });
    return opts;
  }

  function formatTgChainSource(c) {
    if (c.tg_channel_id) {
      var u = c.tg_username ? '@' + c.tg_username : '';
      return (
        '<span class="mono">' +
        esc(c.tg_channel_id) +
        '</span>' +
        (u ? '<div class="muted text-sm">' + esc(u) + '</div>' : '')
      );
    }
    return '<span class="mono">' + esc(c.tg_username ? '@' + c.tg_username : '—') + '</span>';
  }

  var mtprotoLoginId = null;
  var mtprotoNeedsPassword = false;

  function mtprotoStatusLabel(st) {
    if (!st) return 'Не загружено';
    if (st.configured && st.session_valid === true) {
      return st.user_display ? 'Подключено: ' + st.user_display : 'Подключено';
    }
    if (st.has_session && st.session_valid === false) return 'Сессия недействительна';
    if (st.configured) return st.user_display || 'Сессия сохранена';
    if (st.has_credentials && !st.has_session) return 'Нужен вход по телефону';
    return 'Не настроено';
  }

  function buildMtprotoPanelHtml() {
    var html = '<div class="card-like mb-md mtproto-panel" id="ci_mtproto_panel">';
    html += '<div class="flex-between" style="align-items:flex-start;gap:12px;flex-wrap:wrap">';
    html += '<div><h2 class="forwarding-section-title" style="margin:0">MTProto — user-аккаунт Telegram</h2>';
    html +=
      '<p class="muted text-sm" style="margin:6px 0 0;line-height:1.45">Нужен для синхронизации комментариев MAX↔TG и переноса архива канала. Ключи — на <a href="https://my.telegram.org/apps" target="_blank" rel="noopener">my.telegram.org</a>. Аккаунт должен видеть канал (участник или админ).</p></div>';
    html += '<span class="mtproto-status-badge" id="ci_mtproto_badge">…</span></div>';
    html += '<div id="ci_mtproto_hint" class="muted text-sm mt-sm" style="line-height:1.45"></div>';
    html += '<div class="mtproto-grid mt-md">';
    html +=
      '<div class="form-group"><label>api_id</label><input class="input" id="ci_mtproto_api_id" inputmode="numeric" placeholder="12345678" /></div>';
    html +=
      '<div class="form-group"><label>api_hash</label><input class="input" id="ci_mtproto_api_hash" type="password" autocomplete="off" placeholder="из my.telegram.org" /></div>';
    html += '</div>';
    html += '<div class="mt-sm"><button type="button" class="btn btn-ghost btn-sm" id="ci_mtproto_save_creds">Сохранить ключи</button></div>';
    html += '<div id="ci_mtproto_login_block" class="mtproto-login-block mt-md hidden">';
    html += '<div class="mtproto-grid">';
    html +=
      '<div class="form-group"><label>Телефон</label><input class="input" id="ci_mtproto_phone" placeholder="+79001234567" autocomplete="tel" /></div>';
    html +=
      '<div class="form-group"><label>Код из Telegram</label><input class="input" id="ci_mtproto_code" inputmode="numeric" autocomplete="one-time-code" placeholder="12345" /></div>';
    html += '</div>';
    html +=
      '<div class="form-group hidden" id="ci_mtproto_pw_wrap"><label>Пароль 2FA</label><input class="input" id="ci_mtproto_password" type="password" autocomplete="current-password" placeholder="если включён" /></div>';
    html += '<div class="flex-between mt-sm" style="flex-wrap:wrap;gap:8px">';
    html += '<button type="button" class="btn btn-ghost btn-sm" id="ci_mtproto_send_code">Отправить код</button>';
    html += '<button type="button" class="btn btn-primary btn-sm" id="ci_mtproto_confirm">Подтвердить вход</button>';
    html += '</div></div>';
    html += '<div class="mtproto-actions mt-md">';
    html += '<button type="button" class="btn btn-ghost btn-sm" id="ci_mtproto_test">Проверить подключение</button>';
    html += '<button type="button" class="btn btn-danger btn-sm" id="ci_mtproto_logout">Выйти из аккаунта</button>';
    html += '</div></div>';
    return html;
  }

  function applyMtprotoStatusToPanel(main, st) {
    var badge = qs('#ci_mtproto_badge', main);
    var hint = qs('#ci_mtproto_hint', main);
    var arch = qs('#ci_archive', main);
    var loginBlock = qs('#ci_mtproto_login_block', main);
    var pwWrap = qs('#ci_mtproto_pw_wrap', main);
    var apiIdIn = qs('#ci_mtproto_api_id', main);
    var apiHashIn = qs('#ci_mtproto_api_hash', main);
    if (badge) {
      badge.textContent = mtprotoStatusLabel(st);
      badge.className =
        'mtproto-status-badge' +
        (st && st.session_valid === true
          ? ' is-ok'
          : st && st.session_valid === false
            ? ' is-err'
            : '');
    }
    if (hint) {
      hint.textContent = (st && st.hint) || '';
    }
    if (arch && st) {
      arch.disabled = !st.configured;
    }
    if (loginBlock && st) {
      if (st.has_session) {
        loginBlock.classList.add('hidden');
      } else {
        loginBlock.classList.remove('hidden');
      }
    }
    if (pwWrap) {
      if (mtprotoNeedsPassword) pwWrap.classList.remove('hidden');
      else pwWrap.classList.add('hidden');
    }
    if (apiIdIn && st && st.api_id != null && !apiIdIn.value) {
      apiIdIn.value = String(st.api_id);
    }
  }

  function refreshMtprotoPanel(main) {
    return getJsonAbs(API_CHANNEL_IMPORT + '/mtproto')
      .then(function (st) {
        applyMtprotoStatusToPanel(main, st);
        return st;
      })
      .catch(function () {
        applyMtprotoStatusToPanel(main, null);
      });
  }

  function bindMtprotoPanel(main) {
    refreshMtprotoPanel(main);
    var saveCreds = qs('#ci_mtproto_save_creds', main);
    if (saveCreds) {
      saveCreds.addEventListener('click', function () {
        var apiId = (qs('#ci_mtproto_api_id', main).value || '').trim();
        var apiHash = (qs('#ci_mtproto_api_hash', main).value || '').trim();
        if (!apiId || !apiHash) {
          showToast('Укажите api_id и api_hash', 'error');
          return;
        }
        saveCreds.disabled = true;
        putJsonAbs(API_CHANNEL_IMPORT + '/mtproto/credentials', {
          api_id: apiId,
          api_hash: apiHash,
        })
          .then(function () {
            showToast('Ключи сохранены', 'success');
            mtprotoLoginId = null;
            mtprotoNeedsPassword = false;
            return refreshMtprotoPanel(main);
          })
          .catch(function (e) {
            showToast(e.message || 'Ошибка', 'error');
          })
          .finally(function () {
            saveCreds.disabled = false;
          });
      });
    }
    var sendCode = qs('#ci_mtproto_send_code', main);
    if (sendCode) {
      sendCode.addEventListener('click', function () {
        var phone = (qs('#ci_mtproto_phone', main).value || '').trim();
        if (!phone) {
          showToast('Укажите номер телефона', 'error');
          return;
        }
        sendCode.disabled = true;
        postJsonAbs(API_CHANNEL_IMPORT + '/mtproto/send-code', { phone: phone })
          .then(function (data) {
            mtprotoLoginId = data.login_id || null;
            mtprotoNeedsPassword = false;
            var pw = qs('#ci_mtproto_pw_wrap', main);
            if (pw) pw.classList.add('hidden');
            showToast(
              data.is_code_via_app
                ? 'Код отправлен в приложение Telegram'
                : 'Код отправлен (SMS или Telegram)',
              'success',
            );
          })
          .catch(function (e) {
            showToast(e.message || 'Ошибка', 'error');
          })
          .finally(function () {
            sendCode.disabled = false;
          });
      });
    }
    var confirmBtn = qs('#ci_mtproto_confirm', main);
    if (confirmBtn) {
      confirmBtn.addEventListener('click', function () {
        if (mtprotoNeedsPassword && mtprotoLoginId) {
          var password = (qs('#ci_mtproto_password', main).value || '').trim();
          if (!password) {
            showToast('Введите пароль 2FA', 'error');
            return;
          }
          confirmBtn.disabled = true;
          postJsonAbs(API_CHANNEL_IMPORT + '/mtproto/password', {
            login_id: mtprotoLoginId,
            password: password,
          })
            .then(function (data) {
              mtprotoLoginId = null;
              mtprotoNeedsPassword = false;
              showToast('Вход выполнен: ' + (data.user_display || 'OK'), 'success');
              return refreshMtprotoPanel(main);
            })
            .catch(function (e) {
              showToast(e.message || 'Ошибка', 'error');
            })
            .finally(function () {
              confirmBtn.disabled = false;
            });
          return;
        }
        if (!mtprotoLoginId) {
          showToast('Сначала отправьте код', 'error');
          return;
        }
        var code = (qs('#ci_mtproto_code', main).value || '').trim();
        if (!code) {
          showToast('Введите код', 'error');
          return;
        }
        confirmBtn.disabled = true;
        postJsonAbs(API_CHANNEL_IMPORT + '/mtproto/confirm', {
          login_id: mtprotoLoginId,
          code: code,
        })
          .then(function (data) {
            if (data.needs_password) {
              mtprotoNeedsPassword = true;
              mtprotoLoginId = data.login_id || mtprotoLoginId;
              var pw = qs('#ci_mtproto_pw_wrap', main);
              if (pw) pw.classList.remove('hidden');
              showToast('Нужен пароль двухфакторной аутентификации', 'info');
              return;
            }
            mtprotoLoginId = null;
            mtprotoNeedsPassword = false;
            showToast('Вход выполнен: ' + (data.user_display || 'OK'), 'success');
            return refreshMtprotoPanel(main);
          })
          .catch(function (e) {
            showToast(e.message || 'Ошибка', 'error');
          })
          .finally(function () {
            confirmBtn.disabled = false;
          });
      });
    }
    var testBtn = qs('#ci_mtproto_test', main);
    if (testBtn) {
      testBtn.addEventListener('click', function () {
        testBtn.disabled = true;
        postJsonAbs(API_CHANNEL_IMPORT + '/mtproto/test', {})
          .then(function (data) {
            showToast('OK: ' + (data.user_display || 'подключено'), 'success');
            return getJsonAbs(API_CHANNEL_IMPORT + '/mtproto').then(function (st) {
              st.session_valid = true;
              if (data.user_display) st.user_display = data.user_display;
              applyMtprotoStatusToPanel(main, st);
            });
          })
          .catch(function (e) {
            showToast(e.message || 'Ошибка', 'error');
          })
          .finally(function () {
            testBtn.disabled = false;
          });
      });
    }
    var logoutBtn = qs('#ci_mtproto_logout', main);
    if (logoutBtn) {
      logoutBtn.addEventListener('click', function () {
        showConfirm('Выйти из user-аккаунта?', 'Сессия MTProto будет удалена с сервера.', function () {
          deleteAbs(API_CHANNEL_IMPORT + '/mtproto/session')
            .then(function () {
              mtprotoLoginId = null;
              mtprotoNeedsPassword = false;
              showToast('Сессия удалена', 'success');
              return refreshMtprotoPanel(main);
            })
            .catch(function (e) {
              showToast(e.message || 'Ошибка', 'error');
            });
        });
      });
    }
  }

  function renderChannelImport() {
    var main = qs('#mainContent');
    if (!main) return;
    clearChannelImportPoll();
    channelImportJobId = null;
    main.innerHTML = skeletonPage();

    Promise.all([
      fetchMaxLinkedChannels(false).catch(function () {
        return { channels: maxLinkedChatsCache };
      }),
      fetchTelegramLinkedChats(false).catch(function () {
        return { channels: tgLinkedChatsCache };
      }),
    ])
      .then(function (bundle) {
        if (currentRoute !== 'channelimport') return;
        var maxChannels = bundle[0].channels || maxLinkedChatsCache || [];
        var tgChats = bundle[1].channels || tgLinkedChatsCache || [];

        var html = buildMtprotoPanelHtml();
        html += '<div class="card-like mb-md forwarding-section" id="forwarding-section">';
        html += '<h2 class="forwarding-section-title">Импорт канала Telegram → MAX</h2>';
        html +=
          '<p class="muted text-sm" style="margin:0 0 16px;line-height:1.45">Выберите каналы. Без «Архива» — только <em>очередь обновлений</em> reader-бота. С «Архивом» — последние посты через MTProto (блок выше). Reader-бот <code>TG_READER_BOT_TOKEN</code> — админ в TG-канале.</p>';
        html += '<div class="forwarding-add-form forwarding-add-form--picks">';
        html +=
          '<div class="form-group"><div class="flex-between" style="align-items:center;gap:8px;margin-bottom:6px"><label style="margin:0">Канал MAX</label><button type="button" class="btn btn-ghost btn-sm" id="ci_refresh_max"><i data-lucide="refresh-cw"></i> Обновить</button></div><select class="select" id="ci_max">' +
          buildMaxChannelSelectOptions(maxChannels) +
          '</select></div>';
        html +=
          '<div class="form-group" id="ci_tg_wrap"><div class="flex-between" style="align-items:center;gap:8px;margin-bottom:6px"><label style="margin:0">Telegram-канал / чат</label><button type="button" class="btn btn-ghost btn-sm" id="ci_refresh_tg"><i data-lucide="refresh-cw"></i> Обновить</button></div>' +
          buildTelegramChannelSelect('ci_tg_select', tgChats, 'ci_tg_manual') +
          '</div>';
        html += '<div class="form-group" style="margin:0"><label class="checkbox-label">';
        html += '<input type="checkbox" id="ci_archive" disabled /> <strong>Архив канала</strong> (user-аккаунт, до 100 постов)</label>';
        html +=
          '<span class="muted text-sm" style="display:block;margin-top:4px">Включите после настройки MTProto выше</span></div>';
        html += '<div class="forwarding-add-form-actions">';
        html += '<button type="button" class="btn btn-primary" id="ci_start">Запустить анализ</button>';
        html += '<button type="button" class="btn btn-ghost" id="ci_cancel_job" disabled>Отменить задачу</button>';
        html += '</div>';
        html += '</div>';
        html +=
          '<div id="ci_meta_warn" class="hidden mt-sm" style="padding:10px 12px;border-radius:var(--radius-md);border:1px solid #f59e0b55;background:#fef3c722"></div>';
        html += '<div id="ci_pair" class="muted text-sm mt-sm"></div>';
        html += '<div class="mt-md"><span class="muted">Статус: </span><strong id="ci_status">—</strong></div>';
        html += '<div id="ci_hint" class="muted text-sm mt-sm" style="line-height:1.45"></div>';
        html += '<div class="mt-sm"><span class="muted">Подготовлено постов: </span><strong id="ci_count">0</strong></div>';
        html +=
          '<div id="ci_ready_block" class="hidden mt-md" style="padding:14px;border:1px solid var(--accent-border);border-radius:var(--radius-md);background:var(--accent-muted)">';
        html += '<p id="ci_ready_txt" class="text-sm" style="margin:0 0 10px"></p>';
        html += '<button type="button" class="btn btn-primary" id="ci_publish">Опубликовать в MAX</button>';
        html += '</div>';
        html += '</div>';
        main.innerHTML = html;

        var refreshMaxBtn = qs('#ci_refresh_max', main);
        if (refreshMaxBtn) {
          refreshMaxBtn.addEventListener('click', function () {
            refreshMaxBtn.disabled = true;
            fetchMaxLinkedChannels(true)
              .then(function (data) {
                var sel = qs('#ci_max', main);
                if (sel) sel.innerHTML = buildMaxChannelSelectOptions(data.channels || []);
                var n = (data.channels || []).length;
                showToast(
                  n ? 'Список MAX обновлён: ' + n : data.hint || 'Каналы не найдены',
                  n ? 'success' : 'info',
                );
              })
              .catch(function (e) {
                showToast(e.message || 'Ошибка', 'error');
              })
              .finally(function () {
                refreshMaxBtn.disabled = false;
              });
          });
        }

        var refreshTgBtn = qs('#ci_refresh_tg', main);
        if (refreshTgBtn) {
          refreshTgBtn.addEventListener('click', function () {
            refreshTgBtn.disabled = true;
            fetchTelegramLinkedChats(true)
              .then(function (data) {
                var wrap = qs('#ci_tg_wrap', main);
                if (wrap) {
                  var labelRow = wrap.querySelector('.flex-between');
                  wrap.innerHTML = '';
                  if (labelRow) wrap.appendChild(labelRow);
                  var frag = document.createElement('div');
                  frag.innerHTML = buildTelegramChannelSelect(
                    'ci_tg_select',
                    data.channels || [],
                    'ci_tg_manual',
                  );
                  while (frag.firstChild) wrap.appendChild(frag.firstChild);
                }
                var n = (data.channels || []).length;
                showToast(
                  n ? 'Список Telegram обновлён: ' + n : data.hint || 'Чаты не найдены',
                  n ? 'success' : 'info',
                );
              })
              .catch(function (e) {
                showToast(e.message || 'Ошибка', 'error');
              })
              .finally(function () {
                refreshTgBtn.disabled = false;
                refreshIcons();
              });
          });
        }

        bindChannelImportHandlers(main);
        bindMtprotoPanel(main);
        refreshIcons();
      })
      .catch(function (err) {
        if (err && err.message === 'auth') return;
        if (currentRoute !== 'channelimport') return;
        main.innerHTML =
          '<p class="muted">Не удалось загрузить списки каналов: ' + esc(err.message || '') + '</p>';
      });
  }

  function bindChannelImportHandlers(main) {
    var readyBlock = qs('#ci_ready_block', main);
    var publishBtn = qs('#ci_publish', main);
    var startBtn = qs('#ci_start', main);

    function applyImportMeta(meta) {
      var warn = qs('#ci_meta_warn', main);
      if (meta && meta.mtproto) {
        applyMtprotoStatusToPanel(main, meta.mtproto);
      } else if (meta && meta.user_archive_ready) {
        var archOnly = qs('#ci_archive', main);
        if (archOnly) archOnly.disabled = false;
      }
      if (!warn || !meta) return;
      if (!meta.reader_token_ok) {
        warn.textContent = meta.hint || 'Не настроен токен Telegram для импорта.';
        warn.classList.remove('hidden');
      } else if (meta.reader_uses_main_token && meta.hint) {
        warn.textContent = meta.hint;
        warn.classList.remove('hidden');
      } else {
        warn.classList.add('hidden');
      }
    }

    function setUi(job) {
      var st = qs('#ci_status', main);
      var cnt = qs('#ci_count', main);
      var hint = qs('#ci_hint', main);
      var cancelBtn = qs('#ci_cancel_job', main);
      var pair = qs('#ci_pair', main);
      var labels = {
        scanning: 'Сканирование Telegram…',
        archive_fetch: 'Загрузка архива…',
        ready: 'Анализ завершён',
        publishing: 'Публикация в MAX…',
        error: 'Ошибка',
      };
      if (pair && job.tg_channel && job.max_channel_id) {
        pair.textContent = 'Маршрут: ' + job.tg_channel + ' → MAX ' + job.max_channel_id;
      }
      if (st) {
        if (job.status === 'error' && job.error_message) {
          st.textContent = 'Ошибка: ' + String(job.error_message);
        } else if (job.status === 'scanning' && job.scan_idle_rounds != null && job.scan_idle_max) {
          st.textContent =
            labels.scanning +
            ' (' +
            Math.min(Number(job.scan_idle_rounds) + 1, job.scan_idle_max) +
            '/' +
            job.scan_idle_max +
            ')';
        } else {
          st.textContent = labels[job.status] || job.status;
        }
      }
      if (hint) {
        hint.textContent = job.status_hint ? String(job.status_hint) : '';
      }
      if (cnt) cnt.textContent = String(job.staged_count != null ? job.staged_count : 0);
      if (startBtn) {
        startBtn.disabled = job.status === 'scanning' || job.status === 'archive_fetch' || job.status === 'publishing';
      }
      if (cancelBtn) {
        cancelBtn.disabled = !(
          channelImportJobId &&
          (job.status === 'scanning' || job.status === 'archive_fetch' || job.status === 'ready' || job.status === 'error')
        );
      }
      if (job.status === 'ready' && readyBlock) {
        readyBlock.classList.remove('hidden');
        var n = Number(job.staged_count || 0);
        var rt = qs('#ci_ready_txt', main);
        if (publishBtn) publishBtn.disabled = !job.can_publish;
        if (rt) {
          rt.textContent = n
            ? 'Готово к переносу: ' +
              n +
              ' сообщ. Публикация выполняется по одному с паузами (медиа сохраняются).'
            : 'Постов для переноса не найдено. См. подсказку выше.';
        }
      } else if (readyBlock) {
        readyBlock.classList.add('hidden');
      }
    }

    function beginPolling(jobId) {
      channelImportJobId = Number(jobId);
      if (startBtn) startBtn.disabled = true;
      qs('#ci_cancel_job', main).disabled = false;
      clearChannelImportPoll();
      channelImportPollTimer = window.setInterval(tickPoll, 1200);
      tickPoll();
    }

    function tickPoll() {
      if (channelImportJobId == null) return;
      var id = channelImportJobId;
      postJsonAbs(API_CHANNEL_IMPORT + '/jobs/' + encodeURIComponent(String(id)) + '/scan', {})
        .catch(function () {
          return getJsonAbs(API_CHANNEL_IMPORT + '/jobs/' + encodeURIComponent(String(id)));
        })
        .then(function (payload) {
          var job = payload && payload.job ? payload.job : payload;
          if (currentRoute !== 'channelimport') return;
          if (!job) return;
          setUi(job);
          if (job.status === 'ready' || job.status === 'error' || job.status === 'publishing') {
            clearChannelImportPoll();
            if (startBtn) startBtn.disabled = false;
            if (job.status === 'error' && job.error_message) {
              showToast(String(job.error_message), 'error');
            } else if (job.status === 'ready') {
              showToast(
                Number(job.staged_count || 0) > 0
                  ? 'Найдено постов: ' + job.staged_count
                  : 'Анализ завершён: постов в очереди нет',
                Number(job.staged_count || 0) > 0 ? 'success' : 'info',
              );
            }
          }
        })
        .catch(function (e) {
          if (e && e.message === 'auth') return;
          var msg = e && e.message ? String(e.message) : '';
          if (msg.indexOf('404') >= 0) {
            clearChannelImportPoll();
            if (startBtn) startBtn.disabled = false;
            setUi({
              status: 'ready',
              staged_count: 0,
              status_hint:
                'Задача завершена: в очереди Telegram не осталось постов для этого канала.',
              can_publish: false,
            });
            showToast('Постов не найдено', 'info');
            channelImportJobId = null;
            return;
          }
          clearChannelImportPoll();
          if (startBtn) startBtn.disabled = false;
          showToast(msg || 'Ошибка опроса задачи', 'error');
        });
    }

    getJsonAbs(API_CHANNEL_IMPORT + '/meta')
      .then(function (meta) {
        applyImportMeta(meta);
      })
      .catch(function () {});

    getJsonAbs(API_CHANNEL_IMPORT + '/jobs/active')
      .then(function (data) {
        if (data && data.job && data.job.id) {
          setUi(data.job);
          if (data.job.status === 'scanning' || data.job.status === 'archive_fetch') {
            beginPolling(data.job.id);
          } else if (data.job.status === 'ready') {
            channelImportJobId = Number(data.job.id);
          }
        }
      })
      .catch(function () {});

    qs('#ci_start', main).addEventListener('click', function () {
      var tg = readTelegramChannelPick('ci_tg_select', 'ci_tg_manual', main);
      var maxId = (qs('#ci_max', main).value || '').trim();
      if (!tg || !maxId) {
        showToast('Выберите Telegram- и MAX-канал', 'error');
        return;
      }
      if (startBtn) startBtn.disabled = true;
      var useArchive = qs('#ci_archive', main) && qs('#ci_archive', main).checked;
      var payload = { tg_channel: tg, max_channel_id: maxId };
      if (useArchive) {
        payload.archive = true;
        payload.archive_limit = 100;
      }
      setUi({
        status: useArchive ? 'archive_fetch' : 'scanning',
        staged_count: 0,
        tg_channel: tg,
        max_channel_id: maxId,
        scan_idle_rounds: 0,
        scan_idle_max: 5,
        status_hint: useArchive ? 'Загрузка архива канала…' : 'Запуск анализа…',
        can_publish: false,
      });
      postJsonAbs(API_CHANNEL_IMPORT + '/jobs', payload)
        .then(function (res) {
          if (!res || res.id == null) {
            showToast('Нет id задачи', 'error');
            if (startBtn) startBtn.disabled = false;
            return;
          }
          showToast('Анализ запущен', 'success');
          if (readyBlock) readyBlock.classList.add('hidden');
          if (res.job) setUi(res.job);
          beginPolling(res.id);
        })
        .catch(function (e) {
          if (startBtn) startBtn.disabled = false;
          showToast(e.message || 'Ошибка', 'error');
        });
    });

    qs('#ci_cancel_job', main).addEventListener('click', function () {
      if (!channelImportJobId) return;
      var id = channelImportJobId;
      showConfirm('Отменить задачу?', 'Черновик импорта будет удалён из базы.', function () {
        deleteAbs(API_CHANNEL_IMPORT + '/jobs/' + encodeURIComponent(String(id)))
          .then(function () {
            showToast('Отменено', 'success');
            clearChannelImportPoll();
            channelImportJobId = null;
            renderChannelImport();
          })
          .catch(function () {
            showToast('Не удалось отменить', 'error');
          });
      });
    });

    if (publishBtn) {
      publishBtn.addEventListener('click', function () {
        if (!channelImportJobId) {
          showToast('Нет активной задачи', 'error');
          return;
        }
        var id = channelImportJobId;
        publishBtn.disabled = true;
        setUi({ status: 'publishing', staged_count: 0, can_publish: false });
        postJsonAbs(API_CHANNEL_IMPORT + '/jobs/' + encodeURIComponent(String(id)) + '/publish', {})
          .then(function () {
            showToast('Готово. Данные импорта удалены из базы.', 'success');
            clearChannelImportPoll();
            channelImportJobId = null;
            renderChannelImport();
          })
          .catch(function (e) {
            publishBtn.disabled = false;
            showToast(e.message || 'Ошибка публикации', 'error');
          });
      });
    }

    refreshIcons();
  }
  function openChainModal() {
    renderTgChains();
    showToast('Форма настройки — на странице выше', 'info');
  }

  function apStatusLabel(status) {
    var map = {
      active: 'Активен',
      sent: 'Отправлен',
      paused: 'Пауза',
      failed: 'Ошибка',
    };
    return map[status] || status;
  }

  function renderAutoposts() {
    if (window.AutopostHub && window.AutopostHub.render) {
      window.AutopostHub.render();
      return;
    }
    var main = qs('#mainContent');
    if (main) main.innerHTML = '<p class="muted">Модуль автопостинга не загружен</p>';
  }

  function bindIntTabs(main) {
    qsa('[data-int-tab]', main).forEach(function (btn) {
      btn.addEventListener('click', function () {
        integrationsTab = btn.getAttribute('data-int-tab') || 'connections';
        renderIntegrations();
      });
    });
  }

  function integrationPlatformConnected(record) {
    return !!(record && record.status === 'connected' && integrationHasToken(record));
  }

  function renderIntegrationsPageHead(tg, vk, maxMeta, flows, analytics) {
    var tgOk = integrationPlatformConnected(tg);
    var vkOk = integrationPlatformConnected(vk);
    var maxChannels = (maxMeta && maxMeta.channelCount) || (maxMeta && maxMeta.channels && maxMeta.channels.length) || 0;
    var activeFlows = (flows || []).filter(function (f) {
      return f.enabled;
    }).length;
    var forwarded = (analytics && analytics.telegram && analytics.telegram.forwarded) || 0;
    var html = '<header class="int-page-head">';
    html += '<div class="int-page-head-text">';
    html += '<h2>Подключение платформ</h2>';
    html +=
      '<p>Здесь задаются API-токены и загружаются каналы. Чтобы связать каналы для пересылки — откройте раздел «Цепочки».</p>';
    html += '</div>';
    html += '<div class="int-status-pills">';
    html +=
      '<span class="int-status-pill' +
      (tgOk ? ' is-ok' : '') +
      '"><span class="int-pill-dot telegram"></span> Telegram · ' +
      (tgOk ? 'подключён' : 'не настроен') +
      '</span>';
    html +=
      '<span class="int-status-pill is-ok"><span class="int-pill-dot max"></span> MAX · ' +
      esc(String(maxChannels)) +
      ' кан.</span>';
    html +=
      '<span class="int-status-pill' +
      (vkOk ? ' is-ok' : '') +
      '"><span class="int-pill-dot vk"></span> VK · ' +
      (vkOk ? 'подключён' : 'не настроен') +
      '</span>';
    if (activeFlows > 0) {
      html +=
        '<span class="int-status-pill is-muted"><i data-lucide="git-branch"></i> Потоков: <strong>' +
        esc(String(activeFlows)) +
        '</strong></span>';
    }
    if (forwarded > 0) {
      html +=
        '<span class="int-status-pill is-muted"><i data-lucide="arrow-right-left"></i> Переслано: <strong>' +
        esc(String(forwarded)) +
        '</strong></span>';
    }
    html += '</div></header>';
    return html;
  }

  function renderIntegrationsGuide() {
    return (
      '<div class="int-guide">' +
      '<div class="int-guide-item"><div class="int-guide-icon telegram">1</div><div><strong>Платформы</strong><p>Токены Telegram и VK, списки каналов с правами бота.</p></div></div>' +
      '<div class="int-guide-arrow"><i data-lucide="arrow-right"></i></div>' +
      '<div class="int-guide-item"><div class="int-guide-icon max">2</div><div><strong>Цепочки</strong><p>Пары каналов TG→MAX с комментариями и опциями.</p><button type="button" class="btn btn-ghost btn-sm" data-route-jump="tgchains">Открыть цепочки</button></div></div>' +
      '<div class="int-guide-arrow"><i data-lucide="arrow-right"></i></div>' +
      '<div class="int-guide-item"><div class="int-guide-icon vk">3</div><div><strong>Потоки</strong><p>Простые правила «источник → MAX» с фильтрами по словам.</p></div></div>' +
      '</div>'
    );
  }

  function renderIntegrationsTabBar(flowsCount, logCount) {
    var tabs = [
      { id: 'connections', label: 'Платформы', icon: 'plug' },
      { id: 'flows', label: 'Потоки', icon: 'git-branch', badge: flowsCount || null },
      { id: 'analytics', label: 'Журнал', icon: 'bar-chart-2', badge: logCount || null },
    ];
    var html = '<div class="int-tabs" role="tablist">';
    tabs.forEach(function (tab) {
      html +=
        '<button type="button" role="tab" class="int-tab' +
        (integrationsTab === tab.id ? ' active' : '') +
        '" data-int-tab="' +
        tab.id +
        '" aria-selected="' +
        (integrationsTab === tab.id ? 'true' : 'false') +
        '"><i data-lucide="' +
        tab.icon +
        '"></i> ' +
        esc(tab.label);
      if (tab.badge) {
        html += ' <span class="int-tab-badge">' + esc(String(tab.badge)) + '</span>';
      }
      html += '</button>';
    });
    html += '</div>';
    return html;
  }

  function renderIntegrations() {
    var main = qs('#mainContent');
    if (!main) return;
    main.innerHTML = skeletonPage();
    Promise.all([
      getJson('/channels').catch(function () { return { channels: [] }; }),
      getJsonAbs(API_INTEGRATIONS),
      getJsonAbs(API_FLOWS),
      getJsonAbs(API_INTEGRATIONS + '/meta/max'),
      getJsonAbs(API_INT_ANALYTICS),
      getJsonAbs(API_FLOWS + '/log?limit=50'),
    ])
      .then(function (bundle) {
        if (currentRoute !== 'integrations') return;
        channelsCache = (bundle[0].channels || channelsCache).length ? bundle[0].channels : channelsCache;
        integrationsCache = bundle[1].integrations || [];
        flowsCache = bundle[2].flows || [];
        intMaxMeta = bundle[3];
        var analytics = bundle[4];
        var logItems = bundle[5].items || [];
        var tg = integrationsCache.find(function (i) { return i.platform === 'telegram'; });
        var vk = integrationsCache.find(function (i) { return i.platform === 'vk'; });

        var html = '<div class="int-page">';
        html += renderIntegrationsPageHead(tg, vk, intMaxMeta, flowsCache, analytics);
        html += renderIntegrationsGuide();
        html += renderIntegrationsTabBar(flowsCache.length, logItems.length);

        if (integrationsTab === 'connections') {
          html += '<section class="int-section-block">';
          html += sectionHead(
            'Платформы',
            'MAX уже подключён через переменные окружения. Добавьте Telegram-бота и при необходимости VK.',
          );
          html += '<div class="integrations-stack">';
          maxLinkedChatsCache =
            intMaxMeta && intMaxMeta.channels && intMaxMeta.channels.length
              ? intMaxMeta.channels
              : maxLinkedChatsCache;
          html += maxIntegrationCardHtml(intMaxMeta);
          html += integrationCardHtml(
            'telegram',
            'Telegram Bot',
            'Источник постов и комментариев — токен от @BotFather',
            tg,
            'tg',
          );
          html += integrationCardHtml(
            'vk',
            'ВКонтакте',
            'Публикация MAX → VK и работа с сообществами',
            vk,
            'vk',
          );
          html += '</div></section>';
        } else if (integrationsTab === 'flows') {
          html +=
            '<div class="int-info-callout"><i data-lucide="info"></i><div><strong>Потоки</strong> — упрощённые правила пересылки с фильтрами. Для полноценной связки TG→MAX с комментариями используйте <button type="button" class="btn btn-ghost btn-sm" data-route-jump="tgchains">Цепочки</button>.</div></div>';
          html += sectionHead('Активные потоки', 'Источник → MAX. Можно включать, тестировать и удалять.');
          html += '<div class="flows-list">';
          if (flowsCache.length) {
            flowsCache.forEach(function (f) {
              html += flowCardHtml(f);
            });
          } else {
            html += emptyState(
              'git-branch',
              'Потоков пока нет',
              'Создайте правило пересылки из Telegram или VK в MAX-канал.',
              '<button type="button" class="btn btn-primary" id="btnOpenFlowBuilder"><i data-lucide="plus"></i> Создать поток</button>',
            );
          }
          html += '</div>';
          if (flowsCache.length) {
            html +=
              '<div class="int-flows-toolbar"><button type="button" class="btn btn-primary" id="btnOpenFlowBuilder"><i data-lucide="plus"></i> Новый поток</button></div>';
          }
          html += '<div class="flow-builder hidden" id="flow-builder"></div>';
        } else {
          html += sectionHead('Статистика платформ', 'Сводка по подключённым источникам.');
          html += '<div class="analytics-grid">';
          html += analyticsCardHtml('telegram', analytics.telegram);
          html += analyticsCardHtml('vk', analytics.vk);
          html += '</div>';
          html +=
            '<div class="card-like mt-md int-log-card"><div class="card-header flex-between"><div><strong>Журнал пересылок</strong><p class="muted text-sm" style="margin:4px 0 0">Последние посты, прошедшие через потоки</p></div>';
          html += '<select class="select" id="flow-filter-select"><option value="">Все потоки</option>';
          flowsCache.forEach(function (f) {
            html += '<option value="' + esc(f.id) + '">' + esc(f.name || f.id) + '</option>';
          });
          html += '</select></div>';
          html += '<div class="forwarded-list">';
          logItems.forEach(function (item) {
            html += forwardedItemHtml(item);
          });
          if (!logItems.length) {
            html += emptyState(
              'inbox',
              'Пока пусто',
              'Когда потоки начнут пересылать посты, записи появятся здесь.',
            );
          }
          html += '</div></div>';
        }
        html += '</div>';
        main.innerHTML = html;
        bindIntTabs(main);
        bindIntegrationsPage(main);
        bindRouteJumpButtons(main);
        var tgRec = integrationsCache.find(function (i) {
          return i.platform === 'telegram' && i.status === 'connected';
        });
        if (tgRec) {
          tgLinkedChatsCache = tgRec.linkedChats || tgLinkedChatsCache;
          var panel = qs('[data-tg-chats-panel="' + tgRec.id + '"]', main);
          if (panel) {
            mountTelegramChatsPanel(panel, tgRec.id, tgLinkedChatsCache);
            bindTelegramChatsPanel(panel);
            fetchTelegramLinkedChats(true)
              .then(function (data) {
                mountTelegramChatsPanel(panel, tgRec.id, data.channels || []);
                bindTelegramChatsPanel(panel);
                var badge = qs('[data-int-tg-channels-badge="' + tgRec.id + '"]', main);
                if (badge) badge.textContent = String((data.channels || []).length);
                refreshIcons();
              })
              .catch(function () {});
          }
        }
        var maxPanel = qs('[data-max-chats-panel]', main);
        if (maxPanel) {
          mountMaxChatsPanel(maxPanel, maxLinkedChatsCache);
          bindMaxChatsPanel(maxPanel);
          fetchMaxLinkedChannels(true)
            .then(function (data) {
              mountMaxChatsPanel(maxPanel, data.channels || []);
              bindMaxChatsPanel(maxPanel);
              var metaEl = qs('[data-max-channels-meta]', main);
              if (metaEl && data.channels) {
                var admins = data.adminCount != null ? data.adminCount : 0;
                var vals = metaEl.querySelectorAll('.int-stat-val');
                if (vals[0]) vals[0].textContent = String(data.channels.length);
                if (vals[1]) vals[1].textContent = String(admins);
              }
              var badge = qs('.int-card--max .int-details-badge', main);
              if (badge) badge.textContent = String((data.channels || []).length);
              refreshIcons();
            })
            .catch(function () {});
        }
        refreshIcons();
      })
      .catch(function (err) {
        if (err && err.message === 'auth') return;
        main.innerHTML = '<p class="muted">Ошибка: ' + esc(err.message || '') + '</p>';
      });
  }

  function savedTokenBlockHtml(prefix, record) {
    if (!record || record.status !== 'connected' || !integrationHasToken(record)) {
      return '';
    }
    var token = record.token ? String(record.token) : '';
    var preview = integrationTokenPreview(record);
    var display = token || preview;
    var canCopy = token.length > 0;
    return (
      '<div class="saved-token-block">' +
      '<label class="saved-token-label">Токен бота</label>' +
      '<div class="saved-token-row">' +
      '<input class="input mono saved-token-input" type="password" readonly id="' +
      esc(prefix) +
      '-token-saved" value="' +
      esc(display) +
      '" placeholder="Токен сохранён"/>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-toggle-token="' +
      esc(prefix) +
      '-token-saved">Показать</button>' +
      (canCopy
        ? '<button type="button" class="btn btn-ghost btn-sm" data-copy-token="' +
          esc(prefix) +
          '-token-saved">Копировать</button>'
        : '') +
      '</div><p class="muted text-sm saved-token-hint">' +
      (token
        ? 'Токен сохранён. Введите новый в «Настроить» только для замены.'
        : 'Токен сохранён (' +
          esc(preview) +
          '). Полный токен не отображается — введите новый только для замены.') +
      '</p></div>'
    );
  }

  function integrationCardHtml(platform, title, desc, record, prefix) {
    var connected = record && record.status === 'connected';
    var hasToken = integrationHasToken(record);
    var savedToken = record && record.token ? String(record.token) : '';
    var logo = platform === 'vk' ? 'VK' : 'TG';
    var linkedCount = (record && record.linkedChats && record.linkedChats.length) || 0;
    var adminCount =
      record && record.linkedChats
        ? record.linkedChats.filter(function (c) {
            return c.botIsAdmin === true;
          }).length
        : 0;
    var settingsOpen = !connected || !hasToken ? ' open' : '';
    var channelsOpen = platform === 'telegram' && connected && linkedCount === 0 ? ' open' : '';

    var html =
      '<article class="integration-card' +
      (connected && hasToken ? ' connected' : '') +
      ' int-card--' +
      platform +
      '"><div class="int-card-header"><div class="int-logo ' +
      platform +
      '">' +
      logo +
      '</div><div class="int-info"><div class="int-name">' +
      esc(title) +
      '</div><div class="int-desc">' +
      esc(desc) +
      '</div></div><span class="int-status ' +
      (connected && hasToken ? 'connected' : 'disconnected') +
      '">' +
      (connected && hasToken
        ? '<i data-lucide="circle-check"></i> Подключён'
        : connected
          ? '<i data-lucide="alert-circle"></i> Нужен токен'
          : 'Не подключён') +
      '</span></div>';

    if (connected && record && !hasToken) {
      html +=
        '<div class="int-alert"><i data-lucide="alert-triangle"></i> Токен не задан — откройте «Настройки» и вставьте токен от ' +
        (platform === 'vk' ? 'VK' : '@BotFather') +
        '</div>';
    }

    if (connected && record) {
      html += '<div class="int-quick-stats">';
      if (platform === 'telegram') {
        html +=
          '<div class="int-stat"><span class="int-stat-val">' +
          esc(String(linkedCount)) +
          '</span><span class="int-stat-label">чатов</span></div>';
        html +=
          '<div class="int-stat"><span class="int-stat-val">' +
          esc(String(adminCount)) +
          '</span><span class="int-stat-label">админ</span></div>';
      }
      if (record.name) {
        html +=
          '<div class="int-stat"><span class="int-stat-val">' +
          esc(record.name) +
          '</span><span class="int-stat-label">бот</span></div>';
      }
      if (platform === 'vk' && record.groupId) {
        html +=
          '<div class="int-stat"><span class="int-stat-val">' +
          esc(String(record.groupId)) +
          '</span><span class="int-stat-label">сообщество</span></div>';
      }
      html += '</div>';
    }

    html +=
      '<details class="int-details int-details--settings"' +
      settingsOpen +
      '><summary><i data-lucide="settings"></i> Настройки подключения</summary><div class="int-details-body int-body" id="' +
      prefix +
      '-form">';
    if (connected && record) {
      html += savedTokenBlockHtml(prefix, record);
    }
    html +=
      '<div class="form-group"><label>' +
      (platform === 'vk' ? 'Access Token сообщества' : 'Bot Token') +
      '</label><input class="input mono" type="password" id="' +
      prefix +
      '-token" value="' +
      esc(savedToken) +
      '" placeholder="' +
      (hasToken ? 'Оставьте пустым, чтобы не менять · ' : '') +
      (platform === 'vk' ? 'Токен VK API' : 'Токен от @BotFather') +
      '" autocomplete="off"/><p class="muted text-sm form-hint">' +
      (platform === 'vk'
        ? 'Права: wall, photos, docs. ID сообщества — число без минуса.'
        : 'Создайте бота через @BotFather. Без webhook — иначе перехват постов не работает.') +
      '</p></div>';

    if (platform === 'vk') {
      html +=
        '<div class="form-group"><label>ID сообщества VK</label><input class="input" id="vk-group" value="' +
        esc((record && record.groupId) || '') +
        '" placeholder="123456789"/></div>';
    } else {
      html +=
        '<div class="form-group"><label>Имя бота (необязательно)</label><input class="input" id="tg-name" value="' +
        esc((record && record.name) || '') +
        '" placeholder="@my_bot"/></div>';
    }

    html += '<div class="int-actions">';
    html +=
      '<button type="button" class="btn btn-primary" data-connect="' +
      platform +
      '"><i data-lucide="plug"></i> ' +
      (connected ? 'Сохранить' : 'Подключить') +
      '</button>';
    if (record && connected) {
      html +=
        '<button type="button" class="btn btn-ghost" data-test-int="' +
        esc(record.id) +
        '"><i data-lucide="activity"></i> Проверить связь</button>';
    }
    html += '</div></div></details>';

    if (platform === 'telegram' && connected && record) {
      html +=
        '<details class="int-details"' +
        channelsOpen +
        '><summary><i data-lucide="radio"></i> Каналы Telegram <span class="int-details-badge" data-int-tg-channels-badge="' +
        esc(record.id) +
        '">' +
        esc(String(linkedCount)) +
        '</span></summary><div class="int-details-body tg-chats-panel-wrap" data-tg-chats-panel="' +
        esc(record.id) +
        '"></div></details>';
    }

    html += '</article>';
    return html;
  }

  function testFlow(flowId, btn) {
    if (!flowId) return;
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Проверяю...';
    }
    postJsonAbs(API_FLOWS + '/' + encodeURIComponent(flowId) + '/test', {})
      .then(function (data) {
        if (data.ok) {
          showToast(
            'Тест: найдено ' +
              String(data.fetchedPosts ?? 0) +
              ', переслано ' +
              String(data.forwarded ?? 0),
            'success',
          );
        } else {
          showToast('Ошибка: ' + (data.error || 'неизвестно'), 'error');
        }
      })
      .catch(function () {
        showToast('Сетевая ошибка', 'error');
      })
      .finally(function () {
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = '<i data-lucide="activity"></i> Проверить';
          if (window.lucide) window.lucide.createIcons();
        }
      });
  }

  function flowCardHtml(f) {
    var srcName = f.source.channelUsername || f.source.channelId || f.source.platform;
    var destName = channelRegistryTitle(f.destination.channelId) || f.destination.channelId;
    var filterCount =
      (f.filters.keywords && f.filters.keywords.length ? 1 : 0) +
      (f.filters.excludeKeywords && f.filters.excludeKeywords.length ? 1 : 0) +
      (f.filters.mediaOnly ? 1 : 0) +
      (f.filters.delaySeconds > 0 ? 1 : 0);
    var flowTitle = f.name || srcName + ' → ' + destName;
    var html =
      '<article class="flow-card' +
      (f.enabled ? ' is-active' : ' is-paused') +
      '" data-flow-id="' +
      esc(f.id) +
      '">';
    html += '<div class="flow-card-head flex-between">';
    html +=
      '<div><div class="flow-card-title">' +
      esc(flowTitle) +
      '</div><div class="flow-card-sub muted text-sm">' +
      (f.enabled ? 'Активен' : 'На паузе') +
      (filterCount ? ' · ' + filterCount + ' фильтр(ов)' : '') +
      '</div></div>';
    html +=
      '<span class="switch' +
      (f.enabled ? ' on' : '') +
      '" data-flow-toggle="' +
      esc(f.id) +
      '" role="switch" tabindex="0" aria-label="Включить поток"></span>';
    html += '</div>';
    html += '<div class="flow-pipeline">';
    html += flowNodeHtml(f.source.platform, srcName);
    html += '<div class="flow-arrow"><i data-lucide="arrow-right"></i>';
    if (filterCount) {
      html += '<span class="flow-filter-badge"><i data-lucide="filter"></i> ' + filterCount + '</span>';
    }
    html += '</div>' + flowNodeHtml(f.destination.platform, destName);
    html += '</div>';
    html +=
      '<div class="flow-meta"><span class="flow-stat"><i data-lucide="send"></i> Переслано: <strong>' +
      esc(String(f.stats.totalForwarded || 0)) +
      '</strong></span><span class="flow-stat"><i data-lucide="clock"></i> Последний: <strong>' +
      esc(fmtRelativeTime(f.stats.lastForwardedAt)) +
      '</strong></span></div>';
    html +=
      '<div class="flow-actions"><button type="button" class="btn btn-ghost btn-sm" data-test-flow="' +
      esc(f.id) +
      '"><i data-lucide="activity"></i> Тест</button><button type="button" class="btn btn-ghost btn-sm" data-del-flow="' +
      esc(f.id) +
      '"><i data-lucide="trash-2"></i> Удалить</button></div></article>';
    return html;
  }

  function channelRegistryTitle(chatId) {
    var id = Number(chatId);
    var c = channelsCache.find(function (x) { return Number(x.chat_id) === id; });
    return c ? c.title || String(c.chat_id) : null;
  }

  function flowNodeHtml(platform, name) {
    var icon = platform === 'max' ? 'М' : platform === 'vk' ? 'VK' : 'TG';
    return (
      '<div class="flow-node"><div class="flow-node-icon ' +
      platformIconClass(platform) +
      '">' +
      icon +
      '</div><div class="flow-node-info"><div class="flow-node-platform">' +
      esc(platformLabel(platform)) +
      '</div><div class="flow-node-name">' +
      esc(name) +
      '</div></div></div>'
    );
  }

  function analyticsCardHtml(platform, stats) {
    var connected = stats && stats.connected;
    var icon = platform === 'vk' ? 'VK' : 'TG';
    var html =
      '<div class="analytics-card"><div class="analytics-header"><div class="int-logo ' +
      platformIconClass(platform) +
      '" style="width:28px;height:28px;font-size:12px">' +
      icon +
      '</div><span>' +
      esc(platformLabel(platform)) +
      '</span><span class="badge ' +
      (connected ? 'success' : 'disconnected') +
      '">' +
      (connected ? 'подключён' : 'не подключён') +
      '</span></div>';
    if (!connected) {
      return html + '<div class="analytics-empty"><i data-lucide="plug"></i><span>Подключите платформу</span></div></div>';
    }
    html +=
      '<div class="analytics-stats"><div class="a-stat"><div class="a-stat-val">' +
      esc(String(stats.totalPosts)) +
      '</div><div class="a-stat-label">постов</div></div><div class="a-stat"><div class="a-stat-val">' +
      esc(String(stats.forwarded)) +
      '</div><div class="a-stat-label">переслано</div></div><div class="a-stat"><div class="a-stat-val">' +
      esc(String(stats.channels)) +
      '</div><div class="a-stat-label">каналов</div></div></div></div>';
    return html;
  }

  function forwardedItemHtml(item) {
    var fromTag = item.fromPlatform === 'telegram' ? 'TG' : item.fromPlatform === 'vk' ? 'VK' : 'MAX';
    var toTag = item.toPlatform === 'telegram' ? 'TG' : item.toPlatform === 'vk' ? 'VK' : 'MAX';
    return (
      '<div class="forwarded-item" data-flow-id="' +
      esc(item.flowId) +
      '"><div class="fwd-from"><span class="fwd-platform ' +
      platformIconClass(item.fromPlatform) +
      '">' +
      fromTag +
      '</span><span class="fwd-channel">' +
      esc(item.fromChannel) +
      '</span></div><i data-lucide="arrow-right"></i><div class="fwd-to"><span class="fwd-platform ' +
      platformIconClass(item.toPlatform) +
      '">' +
      toTag +
      '</span><span class="fwd-channel">' +
      esc(item.toChannel) +
      '</span></div><div class="fwd-preview">' +
      esc(item.preview) +
      '</div><div class="fwd-time">' +
      esc(fmtRelativeTime(item.forwardedAt)) +
      '</div></div>'
    );
  }

  function bindIntegrationsPage(main) {
    qsa('[data-toggle-token]', main).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-toggle-token');
        var el = id ? qs('#' + id, main) : null;
        if (!el) return;
        var show = el.type === 'password';
        el.type = show ? 'text' : 'password';
        btn.textContent = show ? 'Скрыть' : 'Показать';
      });
    });
    qsa('[data-copy-token]', main).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-copy-token');
        var el = id ? qs('#' + id, main) : null;
        var v = el ? String(el.value || '') : '';
        if (!v) return;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(v).then(function () {
            showToast('Токен скопирован', 'success');
          });
        } else {
          showToast(v, 'info');
        }
      });
    });
    qsa('[data-connect]', main).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var platform = btn.getAttribute('data-connect');
        var el = qs('#' + (platform === 'vk' ? 'vk' : 'tg') + '-token', main);
        var token = el ? String(el.value || '').trim() : '';
        var body = { platform: platform, token: token };
        if (platform === 'telegram') {
          var n = qs('#tg-name', main);
          if (n && n.value.trim()) body.name = n.value.trim();
        } else {
          var g = qs('#vk-group', main);
          if (g && g.value.trim()) body.groupId = g.value.trim();
        }
        var rec = integrationsCache.find(function (i) { return i.platform === platform; });
        if (!token && !(rec && integrationHasToken(rec))) { showToast('Укажите токен', 'error'); return; }
        postJsonAbs(API_INTEGRATIONS + '/connect', body)
          .then(function (res) {
            if (res.integration) {
              var idx = integrationsCache.findIndex(function (i) {
                return i.id === res.integration.id || i.platform === res.integration.platform;
              });
              if (idx >= 0) integrationsCache[idx] = res.integration;
              else integrationsCache.push(res.integration);
            }
            if (res.channels && res.channels.length) {
              tgLinkedChatsCache = res.channels;
            }
            var n = (res.channels && res.channels.length) || 0;
            var msg = n ? 'Подключено. Найдено чатов: ' + n : (res.hint || 'Подключено');
            showToast(msg, n ? 'success' : 'info');
            renderIntegrations();
          })
          .catch(function (e) { showToast(e.message || 'Ошибка', 'error'); });
      });
    });
    qsa('[data-test-int]', main).forEach(function (btn) {
      btn.addEventListener('click', function () {
        postJsonAbs(API_INTEGRATIONS + '/' + encodeURIComponent(btn.getAttribute('data-test-int')) + '/test', {})
          .then(function (r) { showToast(r.ok ? r.info || 'OK' : r.error || 'Ошибка', r.ok ? 'success' : 'error'); })
          .catch(function (e) { showToast(e.message || 'Ошибка', 'error'); });
      });
    });
    qsa('[data-flow-toggle]', main).forEach(function (sw) {
      sw.addEventListener('click', function () {
        var id = sw.getAttribute('data-flow-toggle');
        var next = !sw.classList.contains('on');
        patchJsonAbs(API_FLOWS + '/' + encodeURIComponent(id) + '/toggle', { enabled: next })
          .then(function () { sw.classList.toggle('on', next); })
          .catch(function (e) { showToast(e.message || 'Ошибка', 'error'); });
      });
    });
    qsa('[data-test-flow]', main).forEach(function (btn) {
      btn.addEventListener('click', function () {
        testFlow(btn.getAttribute('data-test-flow'), btn);
      });
    });
    qsa('[data-del-flow]', main).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-del-flow');
        showConfirm('Удалить поток?', '', function () {
          deleteAbs(API_FLOWS + '/' + encodeURIComponent(id)).then(function () {
            showToast('Удалено', 'success');
            renderIntegrations();
          });
        });
      });
    });
    var ob = qs('#btnOpenFlowBuilder', main);
    if (ob) ob.addEventListener('click', function () { openFlowBuilder(main); });
    var ff = qs('#flow-filter-select', main);
    if (ff) {
      ff.addEventListener('change', function () {
        var fid = ff.value;
        qsa('.forwarded-item', main).forEach(function (row) {
          row.style.display = !fid || row.getAttribute('data-flow-id') === fid ? '' : 'none';
        });
      });
    }
  }

  function openFlowBuilder(main) {
    var host = qs('#flow-builder', main);
    if (!host) return;
    host.classList.remove('hidden');
    host.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    var tgBots = integrationsCache.filter(function (i) { return i.platform === 'telegram' && i.status === 'connected'; });
    var vkGroups = integrationsCache.filter(function (i) { return i.platform === 'vk' && i.status === 'connected'; });
    var maxChannels = (intMaxMeta && intMaxMeta.channels) || [];
    host.innerHTML =
      '<div class="flow-builder-head flex-between"><h3>Новый поток</h3><button type="button" class="btn btn-ghost btn-sm" id="fb_cancel"><i data-lucide="x"></i></button></div>' +
      '<div class="flow-builder-steps"><span class="flow-builder-step">① Источник</span><span class="flow-builder-step">② Фильтры</span><span class="flow-builder-step">③ MAX</span></div>' +
      '<div class="builder-grid">' +
      '<div class="builder-step"><div class="step-label"><span class="step-num">1</span> Источник</div>' +
      '<div class="form-group"><label>Платформа</label><select class="select" id="fb_src_platform"><option value="telegram">Telegram</option><option value="vk">VK</option></select></div>' +
      '<div class="form-group"><label>Интеграция</label><select class="select" id="fb_src_int">' +
      tgBots.map(function (b) { return '<option value="' + esc(b.id) + '">' + esc(b.name) + '</option>'; }).join('') +
      '</select></div><div id="fb_src_channel_wrap"></div></div>' +
      '<div class="builder-step"><div class="step-label"><span class="step-num">2</span> Фильтры <span class="step-optional">необязательно</span></div>' +
      '<div class="form-group"><label>Слова (через запятую)</label><input class="input" id="fb_kw" placeholder="новость, анонс"/></div>' +
      '<div class="form-group"><label>Исключить</label><input class="input" id="fb_ex" placeholder="реклама"/></div>' +
      '<label class="checkbox-label"><input type="checkbox" id="fb_media"/> Только посты с медиа</label></div>' +
      '<div class="builder-step"><div class="step-label"><span class="step-num">3</span> Куда в MAX</div>' +
      '<div class="form-group"><label>MAX-канал</label><select class="select" id="fb_dest_channel">' +
      (maxChannels.length
        ? maxChannels.map(function (c) { return '<option value="' + esc(c.id) + '">' + esc(c.title) + '</option>'; }).join('')
        : '<option value="">— сначала загрузите каналы MAX —</option>') +
      '</select></div>' +
      '<div class="form-group"><label>Подпись к посту</label><input class="input" id="fb_signature" placeholder="— TG"/></div></div></div>' +
      '<div class="builder-actions"><button type="button" class="btn btn-primary" id="fb_save"><i data-lucide="check"></i> Создать поток</button><button type="button" class="btn btn-ghost" id="fb_cancel2">Отмена</button></div>';
    if (!tgBots.length && !vkGroups.length) {
      host.innerHTML =
        '<div class="int-info-callout"><i data-lucide="alert-circle"></i><div>Сначала подключите Telegram или VK на вкладке «Платформы», затем создайте поток.</div></div>' +
        '<div class="builder-actions"><button type="button" class="btn btn-ghost" id="fb_cancel">Закрыть</button></div>';
      qs('#fb_cancel', host).addEventListener('click', function () {
        host.classList.add('hidden');
        host.innerHTML = '';
      });
      refreshIcons();
      return;
    }
    function applyFbSourceChannelUi() {
      var wrap = qs('#fb_src_channel_wrap', host);
      if (!wrap || !srcPlatform) return;
      if (srcPlatform.value === 'telegram') {
        wrap.innerHTML =
          '<div class="form-group"><label>Telegram-канал / чат</label>' +
          buildTelegramChannelSelect('fb_src_channel_select', tgLinkedChatsCache, 'fb_src_channel_manual') +
          '</div>';
      } else {
        wrap.innerHTML =
          '<div class="form-group"><label>Канал</label><input class="input" id="fb_src_channel" placeholder="@channel или ID"/></div>';
      }
    }

    var srcPlatform = qs('#fb_src_platform', host);
    var srcInt = qs('#fb_src_int', host);
    fetchTelegramLinkedChats(false)
      .catch(function () { return { channels: tgLinkedChatsCache }; })
      .then(function () { applyFbSourceChannelUi(); });
    if (srcPlatform) {
      srcPlatform.addEventListener('change', function () {
        var list = srcPlatform.value === 'vk' ? vkGroups : tgBots;
        srcInt.innerHTML = list.map(function (b) { return '<option value="' + esc(b.id) + '">' + esc(b.name) + '</option>'; }).join('');
        applyFbSourceChannelUi();
      });
    }
    function closeFlowBuilder() {
      host.classList.add('hidden');
      host.innerHTML = '';
    }
    qs('#fb_cancel', host).addEventListener('click', closeFlowBuilder);
    var cancel2 = qs('#fb_cancel2', host);
    if (cancel2) cancel2.addEventListener('click', closeFlowBuilder);
    qs('#fb_save', host).addEventListener('click', function () {
      var platform = srcPlatform.value;
      var integrationId = srcInt.value;
      var channel =
        readTelegramChannelPick('fb_src_channel_select', 'fb_src_channel_manual', host) ||
        ((qs('#fb_src_channel', host) && qs('#fb_src_channel', host).value) || '').trim();
      var destId = qs('#fb_dest_channel', host).value;
      if (!integrationId || !channel || !destId) { showToast('Заполните поля', 'error'); return; }
      var kw = (qs('#fb_kw', host).value || '').trim();
      var ex = (qs('#fb_ex', host).value || '').trim();
      postJsonAbs(API_FLOWS, {
        source: {
          platform: platform,
          integrationId: integrationId,
          channelUsername: channel.startsWith('@') || !/^-?\d/.test(channel) ? channel : undefined,
          channelId: /^-?\d/.test(channel) ? channel : undefined,
        },
        destination: { platform: 'max', channelId: destId, addCommentsButton: true, signature: (qs('#fb_signature', host).value || '').trim() || undefined },
        filters: {
          keywords: kw ? kw.split(',').map(function (s) { return s.trim(); }).filter(Boolean) : [],
          excludeKeywords: ex ? ex.split(',').map(function (s) { return s.trim(); }).filter(Boolean) : [],
          mediaOnly: qs('#fb_media', host).checked,
          delaySeconds: 0,
        },
      }).then(function () {
        showToast('Поток создан', 'success');
        closeFlowBuilder();
        integrationsTab = 'flows';
        renderIntegrations();
      }).catch(function (e) { showToast(e.message || 'Ошибка', 'error'); });
    });
    refreshIcons();
  }
  function antispamRuleCard(key, label, desc, on) {
    return (
      '<div class="as-rule-card">' +
      toggleRow(key, label, desc, on) +
      '</div>'
    );
  }

  function antispamScoreClass(score, engine) {
    var captcha = engine.captcha_required_score != null ? engine.captcha_required_score : 15;
    var spam = engine.spam_threshold != null ? engine.spam_threshold : 20;
    var ban = engine.ban_threshold != null ? engine.ban_threshold : 100;
    if (score >= ban) return 'danger';
    if (score >= spam) return 'warn';
    if (score >= captcha) return 'caution';
    return 'ok';
  }

  function antispamOutcomeText(result) {
    if (!result) return '—';
    if (result.allowed) {
      if (result.action === 'whitelist') return 'В белом списке';
      if (result.action === 'leave') return 'Комментарий пропущен';
      return 'Разрешено (режим журнала)';
    }
    var map = {
      delete: 'Удаление комментария',
      delete_and_ban: 'Удаление и бан',
      captcha: 'Требуется капча',
      flood: 'Антифлуд',
      blacklist: 'Чёрный список',
      restricted: 'Ограничен',
    };
    return map[result.action] || map[result.reason] || 'Заблокировано';
  }

  function renderAntispamScoreScale(engine) {
    var captcha = engine.captcha_required_score != null ? engine.captcha_required_score : 15;
    var spam = engine.spam_threshold != null ? engine.spam_threshold : 20;
    var ban = engine.ban_threshold != null ? engine.ban_threshold : 100;
    var max = Math.max(ban + 20, 120);
    var pct = function (v) {
      return Math.min(100, Math.max(0, (v / max) * 100));
    };
    var html = '<div class="as-score-scale">';
    html += '<div class="as-score-track">';
    html += '<div class="as-score-zone ok" style="width:' + pct(captcha) + '%"></div>';
    html += '<div class="as-score-zone caution" style="width:' + (pct(spam) - pct(captcha)) + '%"></div>';
    html += '<div class="as-score-zone warn" style="width:' + (pct(ban) - pct(spam)) + '%"></div>';
    html += '<div class="as-score-zone danger" style="flex:1"></div>';
    html += '<span class="as-score-marker" style="left:' + pct(captcha) + '%" title="Капча"><span>' + esc(String(captcha)) + '</span></span>';
    html += '<span class="as-score-marker spam" style="left:' + pct(spam) + '%" title="Удаление"><span>' + esc(String(spam)) + '</span></span>';
    html += '<span class="as-score-marker ban" style="left:' + pct(ban) + '%" title="Бан"><span>' + esc(String(ban)) + '</span></span>';
    html += '</div>';
    html += '<div class="as-score-legend">';
    html += '<span><i class="as-dot ok"></i> Пропуск</span>';
    html += '<span><i class="as-dot caution"></i> Капча ≥ ' + esc(String(captcha)) + '</span>';
    html += '<span><i class="as-dot warn"></i> Удаление ≥ ' + esc(String(spam)) + '</span>';
    html += '<span><i class="as-dot danger"></i> Бан ≥ ' + esc(String(ban)) + '</span>';
    html += '</div></div>';
    return html;
  }

  function renderAntispamThresholdField(id, label, hint, value, min, max) {
    var v = value != null ? value : 0;
    var lo = min != null ? min : 0;
    var hi = max != null ? max : 200;
    var html = '<div class="as-threshold-field">';
    html += '<div class="as-threshold-head"><label for="' + esc(id) + '">' + esc(label) + '</label>';
    html += '<input class="input as-threshold-num" id="' + esc(id) + '" type="number" min="' + lo + '" max="' + hi + '" value="' + esc(String(v)) + '"></div>';
    if (hint) html += '<p class="field-hint">' + esc(hint) + '</p>';
    html +=
      '<input class="as-threshold-range" type="range" min="' +
      lo +
      '" max="' +
      hi +
      '" value="' +
      esc(String(v)) +
      '" data-range-for="' +
      esc(id) +
      '">';
    html += '</div>';
    return html;
  }

  function collectTagsFromWrap(wrap) {
    if (!wrap) return [];
    if (typeof wrap.__tagsGet === 'function') return wrap.__tagsGet(true);
    var tags = [];
    qsa('.tag', wrap).forEach(function (tg) {
      var txt = tg.firstChild;
      if (txt && txt.nodeType === 3) tags.push(String(txt.textContent || '').trim());
    });
    return tags.filter(Boolean);
  }

  function parseUserIdTags(tags) {
    return (tags || [])
      .map(function (s) {
        return parseInt(String(s).trim(), 10);
      })
      .filter(function (n) {
        return !isNaN(n) && n > 0;
      });
  }

  var ANTISPAM_SCORE_META = {
    100: { label: 'Критичные', hint: 'Мгновенный бан при сумме ≥ порога бана' },
    80: { label: 'Сильные', hint: 'Явный спам-сигнал' },
    10: { label: 'Финансы', hint: 'Заработок, казино, инвестиции' },
    9: { label: 'Доход', hint: 'Подработка, удалёнка' },
    8: { label: 'Вакансии и ссылки', hint: 't.me, вакансии, шабашки' },
    7: { label: 'ЛС и работа', hint: '«пиши в лс», разгрузка' },
    6: { label: 'Средние', hint: 'Общие маркеры' },
    5: { label: 'Широкие', hint: 'Темки, валюта, заработок' },
    4: { label: 'Слабые', hint: 'работа, ищу, деньги' },
    3: { label: 'Очень слабые', hint: 'кредит, крипта' },
    0: { label: 'Безопасные', hint: 'Снижают score (−15 за совпадение)' },
  };

  function antispamScoreTierClass(score) {
    if (score >= 100) return 'tier-critical';
    if (score >= 80) return 'tier-high';
    if (score >= 10) return 'tier-medium';
    if (score >= 5) return 'tier-low';
    if (score === 0) return 'tier-safe';
    return 'tier-muted';
  }

  function collectScoredWordsFromEditor(main, tiers) {
    var out = {};
    (tiers || []).forEach(function (tier) {
      var wrap = qs('#as_words_tier_' + tier, main);
      out[String(tier)] = collectTagsFromWrap(wrap);
    });
    return out;
  }

  function saveScoredWordsBase(main, tiers) {
    var btn = qs('#btnSaveScoredWords', main);
    if (btn) btn.disabled = true;
    return postJson('/antispam/scored-words', {
      scored_words: collectScoredWordsFromEditor(main, tiers),
    })
      .then(function () {
        showToast('База стоп-слов сохранена', 'success');
        renderAntispam();
      })
      .catch(function (e) {
        showToast(e.message || 'Ошибка сохранения', 'error');
      })
      .finally(function () {
        if (btn) btn.disabled = false;
      });
  }

  function bindAntispamWordsSearch(main) {
    var input = qs('#as_words_search', main);
    if (!input) return;
    input.addEventListener('input', function () {
      var q = String(input.value || '')
        .trim()
        .toLowerCase();
      qsa('.as-words-tier', main).forEach(function (tierEl) {
        var visible = 0;
        qsa('.tag', tierEl).forEach(function (tag) {
          var text = String(tag.textContent || '').toLowerCase();
          var show = !q || text.indexOf(q) !== -1;
          tag.style.display = show ? '' : 'none';
          if (show) visible += 1;
        });
        tierEl.style.display = !q || visible > 0 ? '' : 'none';
      });
    });
  }

  function collectAntispamPayload(main) {
    var gStop = qs('#g_stop', main);
    var wlWrap = qs('#as_whitelist_wrap', main);
    var blWrap = qs('#as_blacklist_wrap', main);
    var sw = readSwitches(main);
    return {
      global: collectTagsFromWrap(gStop),
      rules: {
        block_links: !!sw.block_links,
        flood_protection: !!sw.flood_protection,
        emoji_spam: !!sw.emoji_spam,
      },
      engine: {
        enabled: !!sw.antispam_enabled,
        soft_mode: !!sw.soft_mode,
        spam_threshold: parseInt(qs('#as_spam_threshold', main).value, 10) || 20,
        ban_threshold: parseInt(qs('#as_ban_threshold', main).value, 10) || 100,
        captcha_required_score: parseInt(qs('#as_captcha_score', main).value, 10) || 15,
        emoji_overuse_limit: parseInt(qs('#as_emoji_limit', main).value, 10) || 20,
        whitelist_user_ids: parseUserIdTags(collectTagsFromWrap(wlWrap)),
        blacklist_user_ids: parseUserIdTags(collectTagsFromWrap(blWrap)),
      },
    };
  }

  function saveAntispamSettings(main) {
    var btn = qs('#btnSaveGlobalAs', main);
    if (btn) btn.disabled = true;
    return postJson('/antispam/words', collectAntispamPayload(main))
      .then(function () {
        showToast('Настройки антиспама сохранены', 'success');
        renderAntispam();
      })
      .catch(function (e) {
        showToast(e.message || 'Ошибка сохранения', 'error');
      })
      .finally(function () {
        if (btn) btn.disabled = false;
      });
  }

  function bindAntispamThresholdRanges(root) {
    qsa('.as-threshold-range', root).forEach(function (range) {
      var targetId = range.getAttribute('data-range-for');
      var num = targetId ? qs('#' + targetId, root) : null;
      if (!num) return;
      function syncFromRange() {
        num.value = range.value;
      }
      function syncFromNum() {
        var v = parseInt(num.value, 10);
        if (!isNaN(v)) range.value = String(v);
      }
      range.addEventListener('input', syncFromRange);
      num.addEventListener('input', syncFromNum);
    });
  }

  function bindAntispamLogFilters(main, log) {
    var tbody = qs('#asp_log_body', main);
    if (!tbody) return;
    var chanSel = qs('#asp_filter_chan', main);
    var reasonSel = qs('#asp_filter_reason', main);
    var qInput = qs('#asp_filter_q', main);
    function apply() {
      var chan = chanSel ? chanSel.value : '';
      var reason = reasonSel ? reasonSel.value : '';
      var q = qInput ? String(qInput.value || '').trim().toLowerCase() : '';
      qsa('tr', tbody).forEach(function (row) {
        var rChan = row.getAttribute('data-chan') || '';
        var rReason = row.getAttribute('data-reason') || '';
        var rText = row.getAttribute('data-text') || '';
        var ok =
          (!chan || rChan === chan) &&
          (!reason || rReason === reason) &&
          (!q || rText.indexOf(q) !== -1 || rReason.toLowerCase().indexOf(q) !== -1);
        row.style.display = ok ? '' : 'none';
      });
    }
    if (chanSel) chanSel.addEventListener('change', apply);
    if (reasonSel) reasonSel.addEventListener('change', apply);
    if (qInput) qInput.addEventListener('input', apply);
  }

  function renderAntispamTestResult(main, result) {
    var host = qs('#as_test_result', main);
    if (!host) return;
    var r = result || {};
    var engine = { captcha_required_score: 15, spam_threshold: 20, ban_threshold: 100 };
    var score = r.spamScore != null ? r.spamScore : 0;
    var cls = r.allowed ? 'ok' : antispamScoreClass(score, engine);
    if (r.action === 'captcha') cls = 'caution';
    var html = '<div class="as-test-card ' + cls + '">';
    html += '<div class="as-test-verdict">' + esc(antispamOutcomeText(r)) + '</div>';
    html += '<div class="as-test-meta">';
    html += '<span>Баллы: <strong>' + esc(String(score)) + '</strong></span>';
    if (r.categories && r.categories.length) {
      html += '<span>Категории: ' + esc(r.categories.join(', ')) + '</span>';
    }
    if (r.reason) html += '<span>Причина: ' + esc(r.reason) + '</span>';
    html += '</div>';
    if (r.userMessage) {
      html += '<p class="as-test-user-msg">' + esc(r.userMessage) + '</p>';
    }
    html += '</div>';
    host.innerHTML = html;
  }

  function bindAntispamTabs(main) {
    qsa('[data-as-tab]', main).forEach(function (btn) {
      btn.addEventListener('click', function () {
        antispamTab = btn.getAttribute('data-as-tab') || 'overview';
        renderAntispam();
      });
    });
  }

  function renderAntispam() {
    var main = qs('#mainContent');
    if (!main) return;
    main.innerHTML = skeletonPage();
    setTopbarActions('');
    Promise.all([getJson('/antispam/words'), getJson('/antispam/log?limit=100')])
      .then(function (pair) {
        if (currentRoute !== 'antispam') return;
        var w = pair[0];
        var log = pair[1].entries || [];
        antispamLogCache = log;
        var rules = w.rules || {};
        var engine = w.engine || {};
        var globalWords = w.global || [];
        var scoredWords = w.scored_words || {};
        var scoreTiers = w.score_tiers || [100, 80, 10, 9, 8, 7, 6, 5, 4, 3, 0];
        var scoredTotal = w.scored_words_total != null ? w.scored_words_total : 0;
        var tabLabels = {
          overview: 'Обзор',
          words: 'База слов',
          settings: 'Настройки',
          test: 'Проверка',
          log: 'Журнал',
        };

        var html = '<div class="as-page">';
        html += '<div class="as-page-head">';
        html += '<div><h2 class="as-page-title">Антиспам</h2>';
        html += '<p class="as-page-desc">Скоринговая фильтрация комментариев: стоп-слова, ссылки, эмодзи и пороги реакции</p></div>';
        html += '<div class="as-status-pills">';
        if (engine.enabled === false) {
          html += '<span class="as-status-pill off"><i data-lucide="shield-off"></i> Выключен</span>';
        } else if (engine.soft_mode) {
          html += '<span class="as-status-pill soft"><i data-lucide="eye"></i> Только журнал</span>';
        } else {
          html += '<span class="as-status-pill on"><i data-lucide="shield-check"></i> Активен</span>';
        }
        html += '</div></div>';

        html += '<div class="as-tabs">';
        Object.keys(tabLabels).forEach(function (tab) {
          html +=
            '<button type="button" class="as-tab' +
            (antispamTab === tab ? ' active' : '') +
            '" data-as-tab="' +
            tab +
            '">' +
            esc(tabLabels[tab]) +
            '</button>';
        });
        html += '</div>';

        if (antispamTab === 'overview') {
          html += '<div class="metrics-grid as-metrics">';
          html +=
            '<div class="metric-card"><div class="label">Блокировок сегодня</div><div class="value">' +
            esc(String(w.blocked_today || 0)) +
            '</div></div>';
          html +=
            '<div class="metric-card"><div class="label">База стоп-слов</div><div class="value">' +
            esc(String(scoredTotal)) +
            '</div></div>';
          html +=
            '<div class="metric-card"><div class="label">Доп. стоп-слов</div><div class="value">' +
            esc(String(globalWords.length)) +
            '</div></div>';
          html +=
            '<div class="metric-card"><div class="label">Белый список</div><div class="value">' +
            esc(String((engine.whitelist_user_ids || []).length)) +
            '</div></div>';
          html +=
            '<div class="metric-card"><div class="label">Чёрный список</div><div class="value">' +
            esc(String((engine.blacklist_user_ids || []).length)) +
            '</div></div>';
          html += '</div>';

          var tgAsBot = w.telegram_antispam_bot || {};
          html += '<div class="as-hint-box mt-md"><i data-lucide="bot"></i><div><strong>Telegram-бот антиспама</strong>';
          if (tgAsBot.configured) {
            html +=
              '<p>Отдельный бот: <code>' +
              esc(tgAsBot.bot_username ? '@' + tgAsBot.bot_username : tgAsBot.token_preview || '—') +
              '</code> — ' +
              (tgAsBot.api_ok ? 'подключён' : 'ошибка API') +
              '. Модерирует группы обсуждений, основной CommentBot занимается синхронизацией.</p>';
          } else {
            html +=
              '<p>Не задан <code>TG_ANTISPAM_BOT_TOKEN</code> — антиспам выполняет основной CommentBot. Для разделения создайте второго бота через @BotFather, добавьте его админом в группу обсуждений (удаление + ограничение) и пропишите токен в <code>.env</code>.</p>';
          }
          html += '</div></div>';

          html += '<div class="panel">';
          html += sectionHead('Как работает скоринг', 'Каждому комментарию начисляются баллы за подозрительные признаки. Итоговое действие зависит от суммы.');
          html += renderAntispamScoreScale(engine);
          html += '<div class="as-scoring-hints">';
          html += '<div class="as-scoring-item"><strong>Телефон, крипто, adult</strong><span>+60…150 баллов, категория hard</span></div>';
          html += '<div class="as-scoring-item"><strong>Ссылки</strong><span>+60 баллов при включённом фильтре</span></div>';
          html += '<div class="as-scoring-item"><strong>Стоп-слова</strong><span>вес зависит от слова, до +90 за кастомные</span></div>';
          html += '<div class="as-scoring-item"><strong>Эмодзи-спам</strong><span>+30 при превышении лимита, +50 за «чистые» эмодзи</span></div>';
          html += '<div class="as-scoring-item"><strong>Антифлуд</strong><span>80 баллов при слишком частых комментариях</span></div>';
          html += '</div></div>';

          html += '<div class="panel mt-md">';
          html += sectionHead('Активные фильтры', 'Текущее состояние глобальных правил');
          html += '<div class="as-channel-rules">';
          html += '<div class="as-rule-pill' + (rules.block_links ? ' on' : '') + '"><i data-lucide="link-2"></i> Ссылки</div>';
          html += '<div class="as-rule-pill' + (rules.flood_protection ? ' on' : '') + '"><i data-lucide="timer"></i> Антифлуд</div>';
          html += '<div class="as-rule-pill' + (rules.emoji_spam ? ' on' : '') + '"><i data-lucide="smile"></i> Эмодзи</div>';
          html += '</div>';
          html +=
            '<p class="muted text-sm mt-sm" style="margin-bottom:0">Редактируйте базу на вкладке «База слов». Дополнительные слова (+90 баллов) — в «Настройки» или в карточке канала.</p>';
          html += '</div>';
        } else if (antispamTab === 'words') {
          html += '<div class="panel">';
          html += sectionHead(
            'Стоп-слова по баллам',
            'Каждое совпадение добавляет баллы к spam score. Enter — добавить, × — удалить.',
          );
          html += '<div class="search-bar as-words-toolbar">';
          html +=
            '<input class="input" id="as_words_search" placeholder="Поиск по словам и фразам…" style="flex:1;min-width:160px">';
          html +=
            '<button type="button" class="btn btn-ghost" id="btnResetScoredWords"><i data-lucide="rotate-ccw"></i> Сбросить базу</button>';
          html += '</div>';
          html += '<div class="as-words-list" id="as_words_list">';
          scoreTiers.forEach(function (tier) {
            var meta = ANTISPAM_SCORE_META[tier] || { label: 'Уровень ' + tier, hint: '' };
            var words = scoredWords[tier] || scoredWords[String(tier)] || [];
            var tierCls = antispamScoreTierClass(tier);
            html += '<details class="as-words-tier ' + tierCls + '" open>';
            html += '<summary class="as-words-tier-head">';
            html += '<span class="as-tier-badge">' + esc(String(tier)) + '</span>';
            html += '<span class="as-tier-title">' + esc(meta.label) + '</span>';
            html += '<span class="as-tier-count">' + esc(String(words.length)) + '</span>';
            if (meta.hint) html += '<span class="as-tier-hint muted">' + esc(meta.hint) + '</span>';
            html += '</summary>';
            html += '<div class="as-words-tier-body">';
            html +=
              '<div class="tags-input-wrap as-words-tags" id="as_words_tier_' +
              esc(String(tier)) +
              '"></div>';
            html += '</div></details>';
          });
          html += '</div>';
          html += '<div class="as-save-bar mt-md">';
          html +=
            '<button type="button" class="btn btn-primary" id="btnSaveScoredWords"><i data-lucide="save"></i> Сохранить базу слов</button>';
          html += '</div></div>';
        } else if (antispamTab === 'settings') {
          html += '<div class="panel">';
          html += sectionHead('Режим работы', 'Глобальные переключатели движка');
          html += '<div id="engineToggles" class="as-mode-toggles">';
          html += toggleRow('antispam_enabled', 'Антиспам включён', 'Полностью отключает проверку комментариев', engine.enabled !== false);
          html += toggleRow('soft_mode', 'Режим наблюдения', 'Записывать срабатывания в журнал, но не блокировать комментарии', !!engine.soft_mode);
          html += '</div></div>';

          html += '<div class="panel mt-md">';
          html += sectionHead('Фильтры контента', 'Что именно проверять в каждом комментарии');
          html += '<div class="as-rule-cards" id="gRules">';
          html += antispamRuleCard('block_links', 'Блокировать ссылки', 'URL, t.me и www в тексте комментария', !!rules.block_links);
          html += antispamRuleCard('flood_protection', 'Антифлуд', 'Ограничение частоты комментариев от одного пользователя', !!rules.flood_protection);
          html += antispamRuleCard('emoji_spam', 'Контроль эмодзи', 'Штраф за избыток эмодзи и сообщения только из эмодзи', !!rules.emoji_spam);
          html += '</div></div>';

          html += '<div class="panel mt-md">';
          html += sectionHead('Дополнительные стоп-слова', 'Поверх базы: +90 баллов за каждое совпадение');
          html += '<div class="form-group"><div class="tags-input-wrap" id="g_stop"></div>';
          html += '<p class="field-hint">Одно слово или фраза — Enter. Не путать с базой на вкладке «База слов».</p></div>';
          html += '</div>';

          html += '<div class="panel mt-md">';
          html += sectionHead('Пороги реакции', 'При какой сумме баллов применяется каждое действие');
          html += renderAntispamScoreScale(engine);
          html += '<div class="as-thresholds-grid mt-md">';
          html += renderAntispamThresholdField(
            'as_captcha_score',
            'Капча',
            'Пользователю предлагается пройти проверку',
            engine.captcha_required_score != null ? engine.captcha_required_score : 15,
            1,
            80,
          );
          html += renderAntispamThresholdField(
            'as_spam_threshold',
            'Удаление',
            'Комментарий удаляется при достаточном числе категорий или hard-нарушении',
            engine.spam_threshold != null ? engine.spam_threshold : 20,
            5,
            120,
          );
          html += renderAntispamThresholdField(
            'as_ban_threshold',
            'Бан',
            'Удаление комментария и блокировка пользователя',
            engine.ban_threshold != null ? engine.ban_threshold : 100,
            40,
            250,
          );
          html += renderAntispamThresholdField(
            'as_emoji_limit',
            'Лимит эмодзи',
            'Сколько эмодзи в одном комментарии считается избыточным',
            engine.emoji_overuse_limit != null ? engine.emoji_overuse_limit : 20,
            5,
            60,
          );
          html += '</div></div>';

          html += '<div class="panel mt-md">';
          html += sectionHead('Списки доступа', 'ID пользователей MAX — всегда пропускать или всегда блокировать');
          html += '<div class="form-row">';
          html += '<div class="form-group"><label>Белый список</label><div class="tags-input-wrap" id="as_whitelist_wrap"></div>';
          html += '<p class="field-hint">Комментарии этих пользователей не проверяются</p></div>';
          html += '<div class="form-group"><label>Чёрный список</label><div class="tags-input-wrap" id="as_blacklist_wrap"></div>';
          html += '<p class="field-hint">Комментарии блокируются без проверки текста</p></div>';
          html += '</div></div>';

          html += '<div class="as-save-bar">';
          html +=
            '<button type="button" class="btn btn-primary" id="btnSaveGlobalAs"><i data-lucide="save"></i> Сохранить настройки</button>';
          html += '</div>';
        } else if (antispamTab === 'test') {
          html += '<div class="panel">';
          html += sectionHead('Проверка текста', 'Симуляция без публикации комментария в канал');
          html += '<div class="form-group"><label>Канал (необязательно)</label>';
          html += '<select class="select" id="as_test_chan" style="max-width:320px"><option value="">Глобальные правила</option></select>';
          html += '<p class="field-hint">Если выбрать канал — учтутся его дополнительные стоп-слова и переопределения</p></div>';
          html += '<div class="form-group"><label>Текст комментария</label>';
          html += '<textarea class="input" id="as_test_text" rows="4" placeholder="Вставьте текст для проверки…"></textarea></div>';
          html += '<button type="button" class="btn btn-primary" id="btnTestAntispam"><i data-lucide="scan-search"></i> Проверить</button>';
          html += '<div id="as_test_result" class="mt-md"></div>';
          html += '</div>';
        } else {
          html += '<div class="panel">';
          html += '<div class="flex-between mb-sm">';
          html += sectionHead('Журнал срабатываний', 'Последние ' + log.length + ' записей');
          html += '<button type="button" class="btn btn-danger btn-sm" id="asp_clear_log"><i data-lucide="trash-2"></i> Очистить</button>';
          html += '</div>';
          if (log.length) {
            html += '<div class="search-bar as-log-filters">';
            html += '<input class="input" id="asp_filter_q" placeholder="Поиск по тексту или причине" style="flex:1;min-width:140px">';
            html += '<select class="select" id="asp_filter_chan"><option value="">Все каналы</option></select>';
            html += '<select class="select" id="asp_filter_reason"><option value="">Все причины</option></select>';
            html += '</div>';
            html += '<div class="table-wrap"><table><thead><tr>';
            html += '<th>Время</th><th>Канал</th><th>Пользователь</th><th>Баллы</th><th>Действие</th><th>Текст</th>';
            html += '</tr></thead><tbody id="asp_log_body">';
            log.forEach(function (e) {
              var chan = e.channel_title || String(e.channel_chat_id);
              var score = e.spam_score != null ? e.spam_score : 0;
              var scoreCls = antispamScoreClass(score, engine);
              html +=
                '<tr data-chan="' +
                esc(chan) +
                '" data-reason="' +
                esc(e.reason || '') +
                '" data-text="' +
                esc(String(e.text || '').toLowerCase()) +
                '">';
              html += '<td class="mono text-sm">' + esc(fmtDateTime(e.created_at)) + '</td>';
              html += '<td>' + esc(chan) + '</td>';
              html += '<td>' + esc(e.username || String(e.user_id)) + '</td>';
              html += '<td><span class="as-score-badge ' + scoreCls + '">' + esc(String(score)) + '</span></td>';
              html += '<td class="text-sm">' + esc(e.reason || '—') + '</td>';
              html +=
                '<td class="as-log-text" title="' +
                esc(e.text) +
                '">' +
                esc(truncateText(e.text, 72)) +
                '</td>';
              html += '</tr>';
            });
            html += '</tbody></table></div>';
          } else {
            html += emptyState('shield-check', 'Срабатываний нет', 'Антиспам ещё не блокировал комментарии');
          }
          html += '</div>';
        }

        html += '</div>';
        main.innerHTML = html;

        if (antispamTab === 'words') {
          scoreTiers.forEach(function (tier) {
            var wrap = qs('#as_words_tier_' + tier, main);
            var words = scoredWords[tier] || scoredWords[String(tier)] || [];
            if (wrap) bindTagsInput(wrap, words, function () {});
          });
          bindAntispamWordsSearch(main);
          var saveWordsBtn = qs('#btnSaveScoredWords', main);
          if (saveWordsBtn) {
            saveWordsBtn.addEventListener('click', function () {
              saveScoredWordsBase(main, scoreTiers);
            });
          }
          var resetBtn = qs('#btnResetScoredWords', main);
          if (resetBtn) {
            resetBtn.addEventListener('click', function () {
              if (!confirm('Сбросить базу стоп-слов к заводским значениям? Текущие правки будут потеряны.')) {
                return;
              }
              postJson('/antispam/scored-words/reset', {})
                .then(function () {
                  showToast('База восстановлена', 'success');
                  renderAntispam();
                })
                .catch(function (e) {
                  showToast(e.message || 'Ошибка', 'error');
                });
            });
          }
          setTopbarActions(
            '<button type="button" class="btn btn-primary btn-sm" id="topbarSaveScoredWords"><i data-lucide="save"></i> Сохранить базу</button>',
          );
          var topSaveWords = qs('#topbarSaveScoredWords');
          if (topSaveWords) {
            topSaveWords.addEventListener('click', function () {
              saveScoredWordsBase(main, scoreTiers);
            });
          }
        }

        if (antispamTab === 'settings') {
          var gStop = qs('#g_stop', main);
          if (gStop) bindTagsInput(gStop, globalWords, function () {});
          var wlWrap = qs('#as_whitelist_wrap', main);
          if (wlWrap) {
            bindTagsInput(
              wlWrap,
              (engine.whitelist_user_ids || []).map(String),
              function () {},
            );
          }
          var blWrap = qs('#as_blacklist_wrap', main);
          if (blWrap) {
            bindTagsInput(
              blWrap,
              (engine.blacklist_user_ids || []).map(String),
              function () {},
            );
          }
          bindToggleRows(main, null);
          bindAntispamThresholdRanges(main);
          var saveBtn = qs('#btnSaveGlobalAs', main);
          if (saveBtn) {
            saveBtn.addEventListener('click', function () {
              saveAntispamSettings(main);
            });
          }
          setTopbarActions(
            '<button type="button" class="btn btn-primary btn-sm" id="topbarSaveAntispam"><i data-lucide="save"></i> Сохранить</button>',
          );
          var topSave = qs('#topbarSaveAntispam');
          if (topSave) {
            topSave.addEventListener('click', function () {
              saveAntispamSettings(main);
            });
          }
        }

        if (antispamTab === 'test') {
          var chanSel = qs('#as_test_chan', main);
          if (chanSel) {
            var chans = channelsCache.length ? channelsCache : [];
            var loadChans = chans.length
              ? Promise.resolve({ channels: chans })
              : getJson('/channels?summary=1');
            loadChans.then(function (data) {
              if (currentRoute !== 'antispam') return;
              var list = data.channels || [];
              if (!channelsCache.length) channelsCache = list;
              chanSel.innerHTML =
                '<option value="">Глобальные правила</option>' +
                list
                  .map(function (c) {
                    return (
                      '<option value="' +
                      esc(String(c.chat_id)) +
                      '">' +
                      esc(c.title || String(c.chat_id)) +
                      '</option>'
                    );
                  })
                  .join('');
            });
          }
          var btnTest = qs('#btnTestAntispam', main);
          if (btnTest) {
            btnTest.addEventListener('click', function () {
              var text = String(qs('#as_test_text', main).value || '');
              if (!text.trim()) {
                showToast('Введите текст для проверки', 'error');
                return;
              }
              var chatId = chanSel ? Number(chanSel.value) || 0 : 0;
              btnTest.disabled = true;
              postJson('/antispam/test', { text: text, chat_id: chatId })
                .then(function (data) {
                  renderAntispamTestResult(main, data.result || {});
                })
                .catch(function (e) {
                  showToast(e.message || 'Ошибка', 'error');
                })
                .finally(function () {
                  btnTest.disabled = false;
                });
            });
          }
        }

        if (antispamTab === 'log' && log.length) {
          var chanFilter = qs('#asp_filter_chan', main);
          var reasonFilter = qs('#asp_filter_reason', main);
          var chans = [];
          var reasons = [];
          log.forEach(function (e) {
            var ch = e.channel_title || String(e.channel_chat_id);
            if (chans.indexOf(ch) === -1) chans.push(ch);
            if (e.reason && reasons.indexOf(e.reason) === -1) reasons.push(e.reason);
          });
          if (chanFilter) {
            chans.forEach(function (ch) {
              chanFilter.innerHTML += '<option value="' + esc(ch) + '">' + esc(ch) + '</option>';
            });
          }
          if (reasonFilter) {
            reasons.forEach(function (r) {
              reasonFilter.innerHTML += '<option value="' + esc(r) + '">' + esc(r) + '</option>';
            });
          }
          bindAntispamLogFilters(main, log);
        }

        var clearBtn = qs('#asp_clear_log', main);
        if (clearBtn) {
          clearBtn.addEventListener('click', function () {
            showConfirm('Очистить журнал?', 'Все записи будут удалены без возможности восстановления.', function () {
              postJson('/antispam/log/clear', {})
                .then(function () {
                  showToast('Журнал очищен', 'success');
                  renderAntispam();
                })
                .catch(function (e) {
                  showToast(e.message || 'Ошибка', 'error');
                });
            });
          });
        }

        bindAntispamTabs(main);
        refreshIcons();
      })
      .catch(function (err) {
        if (err && err.message === 'auth') return;
        main.innerHTML = '<p class="muted">Ошибка загрузки настроек антиспама</p>';
      });
  }

  function renderComments() {
    var main = qs('#mainContent');
    if (!main) return;
    main.innerHTML =
      '<div class="search-bar">' +
      '<select class="select" id="com_chat" style="max-width:280px"><option value="">Загрузка каналов…</option></select>' +
      '<input class="input" id="com_q" placeholder="Поиск" value="' +
      esc(commentsQuery) +
      '"/>' +
      '<select class="select" id="cm_filter_status" style="max-width:160px">' +
      '<option value="">Все статусы</option>' +
      '<option value="answered">Отвечено</option>' +
      '<option value="pending">Ожидает</option>' +
      '</select>' +
      '<button type="button" class="btn btn-primary" id="com_load">Показать</button></div>' +
      '<div id="com_list" class="muted">Загрузка…</div>';
    getJson('/channels?summary=1')
      .then(function (data) {
        if (currentRoute !== 'comments') return;
        channelsCache = data.channels || [];
        channelsCacheLight = true;
        if (!commentsChatId && channelsCache[0]) commentsChatId = channelsCache[0].chat_id;
        var sel = channelsCache
          .map(function (c) {
            return (
              '<option value="' +
              esc(String(c.chat_id)) +
              '"' +
              (c.chat_id === commentsChatId ? ' selected' : '') +
              '>' +
              esc(c.title || String(c.chat_id)) +
              '</option>'
            );
          })
          .join('');
        var chatEl = qs('#com_chat', main);
        if (chatEl) {
          chatEl.innerHTML = sel || '<option value="">Нет каналов</option>';
        }
        qs('#com_load', main).addEventListener('click', function () {
          commentsChatId = Number(qs('#com_chat', main).value);
          commentsQuery = (qs('#com_q', main).value || '').trim();
          loadCommentsList();
        });
        if (chatEl) {
          chatEl.addEventListener('change', function () {
            commentsChatId = Number(chatEl.value);
            loadCommentsList();
          });
        }
        var statusSel = qs('#cm_filter_status', main);
        if (statusSel) {
          statusSel.value = commentsStatusFilter || '';
          statusSel.addEventListener('change', function () {
            commentsStatusFilter = statusSel.value;
            loadCommentsList();
          });
        }
        if (commentsChatId) {
          loadCommentsList();
        } else {
          var host = qs('#com_list', main);
          if (host) host.textContent = 'Нет подключённых каналов';
        }
        refreshIcons(main);
      })
      .catch(function () {
        main.innerHTML = '<p class="muted">Не удалось загрузить каналы</p>';
      });
  }

  function loadCommentsList() {
    var host = qs('#com_list');
    if (!host || !commentsChatId) return;
    host.innerHTML = 'Загрузка…';
    var q = commentsQuery ? '&q=' + encodeURIComponent(commentsQuery) : '';
    var statusQ = commentsStatusFilter ? '&status=' + encodeURIComponent(commentsStatusFilter) : '';
    getJson('/comments?chat_id=' + encodeURIComponent(String(commentsChatId)) + q + statusQ + '&limit=150')
      .then(function (data) {
        var list = data.comments || [];
        var html = '';
        if (data.truncated) {
          html +=
            '<p class="text-sm muted" style="margin-bottom:8px">Показаны последние ' +
            esc(String(data.returned || list.length)) +
            ' из ' +
            esc(String(data.total_in_channel || list.length)) +
            ' комментариев. Уточните поиск, чтобы найти остальные.</p>';
        }
        if (!list.length) {
          html += emptyState('message-square-off', 'Нет комментариев', 'Попробуйте изменить фильтры или выбрать другой канал');
        } else {
          html += '<div class="table-wrap"><table><thead><tr>';
          html += '<th>Пост</th><th>Автор</th><th>Текст</th><th>Время</th><th></th></tr></thead><tbody>';
          list.forEach(function (c) {
            html += '<tr>';
            html += '<td style="max-width:160px">' + esc(c.post_preview || c.post_id) + '</td>';
            html += '<td>' + esc(c.username) + '<div class="mono text-sm muted">' + esc(String(c.user_id)) + '</div></td>';
            html += '<td>' + esc(c.text) + '</td>';
            html += '<td class="text-sm">' + esc(c.timestamp) + '</td>';
            html +=
              '<td><button type="button" class="btn btn-danger btn-sm" data-del-com="' +
              esc(c.comment_id) +
              '">Удалить</button></td>';
            html += '</tr>';
          });
          html += '</tbody></table></div>';
        }
        host.innerHTML = html;
        qsa('[data-del-com]', host).forEach(function (b) {
          b.addEventListener('click', function () {
            var id = b.getAttribute('data-del-com');
            showConfirm('Удалить комментарий?', 'Комментарий будет удалён из базы.', function () {
              postJson('/comments/delete', { comment_id: id })
                .then(function () {
                  showToast('Удалено', 'success');
                  loadCommentsList();
                })
                .catch(function (e) {
                  showToast(e.message || 'Ошибка', 'error');
                });
            });
          });
        });
        refreshIcons();
      })
      .catch(function (e) {
        host.innerHTML = '<p class="muted">' + esc(e.message || 'Ошибка') + '</p>';
      });
  }

  function userRoleLabel(role) {
    if (role === 'owner') return 'Владелец';
    if (role === 'admin') return 'Администратор';
    return 'Пользователь';
  }

  function renderUserStatusBadges(user) {
    var html = '';
    html += '<span class="badge ' + (user.is_restricted ? 'badge-danger' : 'badge-active') + '">' + esc(user.is_restricted ? 'Ограничен' : 'Активен') + '</span>';
    html += '<span class="badge badge-muted">' + esc(userRoleLabel(user.role)) + '</span>';
    html += '<span class="badge ' + (user.started_bot ? 'badge-accent' : 'badge-muted') + '">' + esc(user.started_bot ? 'Бот запущен' : 'Бот не запускал') + '</span>';
    return html;
  }

  function filterUsersList() {
    var q = String(usersFilterQuery || '').trim().toLowerCase();
    var channelFilterNum = /^-?\d+$/.test(String(usersFilterChannel || ''))
      ? Number(usersFilterChannel)
      : null;
    return usersCache.filter(function (u) {
      if (usersFilterStatus === 'restricted' && !u.is_restricted) return false;
      if (usersFilterStatus === 'active' && u.is_restricted) return false;
      if (usersFilterStarted === 'started' && !u.started_bot) return false;
      if (usersFilterStarted === 'not_started' && u.started_bot) return false;
      if (channelFilterNum !== null) {
        var hasChannel = (u.channel_links || []).some(function (link) {
          return Number(link.chat_id) === channelFilterNum;
        });
        if (!hasChannel) return false;
      }
      if (!q) return true;
      var channelText = (u.channel_links || [])
        .map(function (x) {
          return String(x.channel_title || x.chat_id || '');
        })
        .join(' ')
        .toLowerCase();
      var hay = [
        String(u.user_id || ''),
        String(u.name || ''),
        String(u.role || ''),
        channelText,
      ]
        .join(' ')
        .toLowerCase();
      return hay.indexOf(q) !== -1;
    });
  }

  function usersChannelFilterOptionsHtml() {
    var byChat = {};
    usersCache.forEach(function (u) {
      (u.channel_links || []).forEach(function (link) {
        var key = String(link.chat_id);
        if (!byChat[key]) {
          byChat[key] = {
            chat_id: link.chat_id,
            title: link.channel_title || 'Канал ' + link.chat_id,
          };
        }
      });
    });
    var list = Object.keys(byChat)
      .map(function (k) {
        return byChat[k];
      })
      .sort(function (a, b) {
        return String(a.title).localeCompare(String(b.title), 'ru');
      });
    var html =
      '<option value="all"' +
      (usersFilterChannel === 'all' ? ' selected' : '') +
      '>Все каналы</option>';
    list.forEach(function (ch) {
      var value = String(ch.chat_id);
      html +=
        '<option value="' +
        esc(value) +
        '"' +
        (usersFilterChannel === value ? ' selected' : '') +
        '>' +
        esc(ch.title) +
        '</option>';
    });
    return html;
  }

  function usersListHtml(list) {
    if (!list.length) {
      return emptyState('users', 'Нет пользователей', 'Пользователи появятся после первых взаимодействий с ботом');
    }
    var html = '';
    list.forEach(function (u) {
      var channels = u.channel_links || [];
      html +=
        '<button type="button" class="user-list-item' +
        (u.user_id === selectedUserId ? ' active' : '') +
        '" data-user-id="' +
        esc(String(u.user_id)) +
        '">';
      html += '<div class="user-list-head user-list-head-clean">';
      html += '<div class="user-list-identity">';
      html += '<div class="user-list-name">' + esc(u.name || 'Без имени') + '</div>';
      html += '</div>';
      html += '</div>';
      html += '<div class="user-list-channels">';
      if (!channels.length) {
        html += '<span class="user-channel-tag user-channel-tag-empty">Не привязан к каналу</span>';
      } else {
        channels.forEach(function (link) {
          var title = link.channel_title || ('Канал ' + link.chat_id);
          html += '<span class="user-channel-tag" title="' + esc(title) + '">' + esc(title) + '</span>';
        });
      }
      html += '</div>';
      html += '</button>';
    });
    return html;
  }

  function renderUserCommentsHistory(detail, filter) {
    var bucket = detail && detail.comments ? detail.comments : {};
    var list =
      filter === 'answered'
        ? bucket.answered || []
        : filter === 'unanswered'
          ? bucket.unanswered || []
          : (bucket.answered || []).concat(bucket.unanswered || []);
    if (!list.length) {
      return '<p class="muted">Комментариев по фильтру нет.</p>';
    }
    var html = '<div class="recent-comments">';
    list.forEach(function (c) {
      var post = c.post_context || {};
      var channelLabel = post.channel_title ? String(post.channel_title) : post.chat_id ? 'Канал ' + post.chat_id : 'Канал не найден';
      html += '<article class="comment-card">';
      html += '<div class="comment-card-head">';
      html += '<div class="comment-card-user"><strong>' + esc(channelLabel) + '</strong>';
      html += '<span class="comment-card-time">' + esc(fmtDateTime(c.timestamp)) + '</span></div>';
      html +=
        '<span class="comment-status ' +
        (c.status === 'answered' ? 'answered' : 'pending') +
        '">' +
        esc(c.status === 'answered' ? 'Отвечено' : 'Без ответа') +
        '</span>';
      html += '</div>';
      html += '<div class="comment-card-text">' + esc(c.text || '') + '</div>';
      var postUrl = post.channel_post_url && String(post.channel_post_url).trim() ? String(post.channel_post_url).trim() : '';
      html += postUrl
        ? '<a class="comment-post-context" href="' + esc(postUrl) + '" target="_blank" rel="noopener noreferrer">'
        : '<div class="comment-post-context">';
      html += '<span class="comment-post-label">Пост</span>';
      if (post.photo_url) {
        html += '<img class="comment-post-thumb" src="' + esc(post.photo_url) + '" alt="" loading="lazy" />';
      }
      html += '<div class="comment-post-body">';
      html += '<div class="comment-post-text">' + esc(truncateText(post.text || 'Без текста', 140)) + '</div>';
      if (post.timestamp) {
        html += '<span class="comment-post-time">' + esc(fmtDateTime(post.timestamp)) + '</span>';
      }
      html += '</div>' + (postUrl ? '</a>' : '</div>');
      if (c.reply && c.reply.text) {
        html += '<div class="comment-reply-block">';
        html += '<div class="comment-reply-label">Ответ администратора' + (c.reply.admin_name ? ' · ' + esc(c.reply.admin_name) : '') + '</div>';
        html += '<div class="comment-reply-text">' + esc(c.reply.text) + '</div>';
        html += '<span class="comment-reply-time">' + esc(fmtDateTime(c.reply.timestamp)) + '</span>';
        html += '</div>';
      }
      html += '</article>';
    });
    html += '</div>';
    return html;
  }

  function renderUserDetail(userId) {
    var detailHost = qs('#usersDetail');
    if (!detailHost) return;
    if (!userId) {
      detailHost.innerHTML =
        '<div class="empty-state"><i data-lucide="user"></i><h3>Выберите пользователя</h3><p>Слева откройте карточку, чтобы увидеть профиль, каналы и историю комментариев.</p></div>';
      refreshIcons();
      return;
    }
    detailHost.innerHTML = '<div class="dash-loading muted">Загрузка карточки пользователя…</div>';
    getJson('/users/' + encodeURIComponent(String(userId)))
      .then(function (data) {
        if (currentRoute !== 'users' || selectedUserId !== userId) return;
        userDetailCache[userId] = data;
        var u = data.user || {};
        var stats = u.comment_stats || {};
        var links = u.channel_links || [];
        var html = '<section class="panel user-detail-panel">';
        html += '<div class="user-detail-header">';
        html += userAvatarHtml(u, 'user-detail-avatar');
        html += '<div class="user-detail-head-main">';
        html += '<h2>' + esc(u.name || 'Без имени') + '</h2>';
        html += '<div class="user-detail-id mono">ID: ' + esc(String(u.user_id || userId)) + '</div>';
        html += '<div class="user-detail-badges">' + renderUserStatusBadges(u) + '</div>';
        html += '</div>';
        html += '</div>';

        html += '<div class="user-kpi-grid">';
        html += '<div class="stat-card"><div class="label">Дата подписки</div><div class="value user-kpi-value">' + esc(fmtDateTime(u.registered_at)) + '</div></div>';
        html += '<div class="stat-card"><div class="label">Последний комментарий</div><div class="value user-kpi-value">' + esc(fmtDateTime(stats.last_comment_at)) + '</div></div>';
        html += '<div class="stat-card"><div class="label">Комментарии</div><div class="value">' + esc(String(stats.total || 0)) + '</div><div class="sub">Ответов: ' + esc(String(stats.answered || 0)) + ' · Без ответа: ' + esc(String(stats.unanswered || 0)) + '</div></div>';
        html += '<div class="stat-card"><div class="label">Привязанный чат</div><div class="value user-kpi-value mono">' + esc(u.private_chat_id ? String(u.private_chat_id) : '—') + '</div></div>';
        html += '</div>';

        html += '<h3 class="section-title">Привязанные каналы</h3>';
        if (!links.length) {
          html += '<p class="muted">' + esc(u.context_hint || 'Нет привязанных каналов') + '</p>';
        } else {
          html += '<div class="user-channel-links">';
          links.forEach(function (l) {
            html += '<div class="user-channel-card">';
            html += '<strong>' + esc(l.channel_title || ('Канал ' + l.chat_id)) + '</strong>';
            html += '<div class="text-sm text-secondary mono">chat_id: ' + esc(String(l.chat_id)) + '</div>';
            html += '<div class="text-sm">' + esc((l.relations || []).join(', ') || '—') + '</div>';
            html += '</div>';
          });
          html += '</div>';
        }

        html += '<div class="user-actions-row">';
        html += '<button type="button" class="btn btn-ghost btn-sm" data-user-action="notify" data-user-id="' + esc(String(u.user_id || userId)) + '"><i data-lucide="send"></i> Уведомить</button>';
        if (u.role !== 'owner') {
          html += '<button type="button" class="btn btn-ghost btn-sm" data-user-action="restrict" data-user-id="' + esc(String(u.user_id || userId)) + '" data-restricted="' + (u.is_restricted ? '1' : '0') + '"><i data-lucide="' + (u.is_restricted ? 'unlock' : 'shield-ban') + '"></i> ' + esc(u.is_restricted ? 'Снять ограничение' : 'Ограничить') + '</button>';
          html += '<button type="button" class="btn btn-danger btn-sm" data-user-action="remove" data-user-id="' + esc(String(u.user_id || userId)) + '"><i data-lucide="user-minus"></i> Удалить</button>';
        }
        html += '</div>';

        html += '<div class="tabs user-comments-tabs">';
        html += '<button type="button" class="tab active" data-user-comments-filter="all">Все (' + esc(String(data.comments && data.comments.total ? data.comments.total : 0)) + ')</button>';
        html += '<button type="button" class="tab" data-user-comments-filter="answered">С ответом (' + esc(String((data.comments && data.comments.answered ? data.comments.answered.length : 0))) + ')</button>';
        html += '<button type="button" class="tab" data-user-comments-filter="unanswered">Без ответа (' + esc(String((data.comments && data.comments.unanswered ? data.comments.unanswered.length : 0))) + ')</button>';
        html += '</div>';
        html += '<div id="userCommentsHost">' + renderUserCommentsHistory(data, 'all') + '</div>';
        html += '</section>';
        detailHost.innerHTML = html;
        bindUserDetailEvents();
        refreshIcons();
      })
      .catch(function (e) {
        detailHost.innerHTML = '<p class="muted">' + esc(e.message || 'Не удалось загрузить карточку пользователя') + '</p>';
      });
  }

  function openNotifyUserModal(userId) {
    var host = qs('#modalRoot');
    if (!host) return;
    var backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    var modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML =
      '<h2>Отправить уведомление</h2>' +
      '<p>Пользователь получит сообщение от бота в личный чат.</p>' +
      '<div class="form-group"><label for="userNotifyText">Текст сообщения</label><textarea id="userNotifyText" class="textarea" rows="5" maxlength="2000" placeholder="Введите текст уведомления"></textarea></div>' +
      '<div class="modal-actions">' +
      '<button type="button" class="btn btn-ghost" data-close-modal>Отмена</button>' +
      '<button type="button" class="btn btn-primary" data-send-notify>Отправить</button>' +
      '</div>';
    backdrop.appendChild(modal);
    host.appendChild(backdrop);
    function close() {
      if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
    }
    var closeBtn = qs('[data-close-modal]', modal);
    var sendBtn = qs('[data-send-notify]', modal);
    var textArea = qs('#userNotifyText', modal);
    if (closeBtn) closeBtn.addEventListener('click', close);
    if (sendBtn) {
      sendBtn.addEventListener('click', function () {
        var text = textArea ? String(textArea.value || '').trim() : '';
        if (!text) {
          showToast('Введите текст уведомления', 'error');
          return;
        }
        sendBtn.disabled = true;
        postJson('/users/notify', { user_id: userId, text: text })
          .then(function () {
            showToast('Уведомление отправлено', 'success');
            close();
          })
          .catch(function (e) {
            showToast(e.message || 'Не удалось отправить уведомление', 'error');
          })
          .finally(function () {
            sendBtn.disabled = false;
          });
      });
    }
    if (textArea) textArea.focus();
  }

  function bindUserDetailEvents() {
    var root = qs('#usersDetail');
    if (!root) return;
    qsa('[data-user-comments-filter]', root).forEach(function (tab) {
      tab.addEventListener('click', function () {
        qsa('[data-user-comments-filter]', root).forEach(function (x) {
          x.classList.remove('active');
        });
        tab.classList.add('active');
        var filter = tab.getAttribute('data-user-comments-filter') || 'all';
        var detail = selectedUserId ? userDetailCache[selectedUserId] : null;
        var host = qs('#userCommentsHost', root);
        if (host) host.innerHTML = renderUserCommentsHistory(detail, filter);
      });
    });
    qsa('[data-user-action]', root).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var action = btn.getAttribute('data-user-action');
        var uid = Number(btn.getAttribute('data-user-id'));
        if (!uid || !action) return;
        if (action === 'notify') {
          openNotifyUserModal(uid);
          return;
        }
        if (action === 'restrict') {
          var restricted = btn.getAttribute('data-restricted') === '1';
          var next = !restricted;
          postJson('/users/restrict', { user_id: uid, restricted: next })
            .then(function () {
              showToast(next ? 'Пользователь ограничен' : 'Ограничение снято', 'success');
              renderUsers();
            })
            .catch(function (e) {
              showToast(e.message || 'Ошибка', 'error');
            });
          return;
        }
        if (action === 'remove') {
          showConfirm('Удалить пользователя?', 'Пользователь ' + uid + ' будет отключён от бота.', function () {
            postJson('/users/remove', { user_id: uid })
              .then(function () {
                showToast('Пользователь удалён', 'success');
                renderUsers();
              })
              .catch(function (e) {
                showToast(e.message || 'Ошибка', 'error');
              });
          });
        }
      });
    });
  }

  function bindUsersListItemEvents(main) {
    qsa('.user-list-item[data-user-id]', main).forEach(function (item) {
      item.addEventListener('click', function () {
        var uid = Number(item.getAttribute('data-user-id'));
        if (!uid || uid === selectedUserId) return;
        selectedUserId = uid;
        qsa('.user-list-item', main).forEach(function (x) {
          x.classList.remove('active');
        });
        item.classList.add('active');
        renderUserDetail(uid);
      });
    });
  }

  function bindUsersPageEvents() {
    var main = qs('#mainContent');
    if (!main) return;
    var search = qs('#usersSearch', main);
    var status = qs('#usersStatusFilter', main);
    var started = qs('#usersStartedFilter', main);
    var channel = qs('#usersChannelFilter', main);
    if (search && search.getAttribute('data-bound') !== '1') {
      search.setAttribute('data-bound', '1');
      search.addEventListener('input', function () {
        usersFilterQuery = String(search.value || '');
        var listHost = qs('#usersListHost', main);
        if (listHost) listHost.innerHTML = usersListHtml(filterUsersList());
        bindUsersListItemEvents(main);
        refreshIcons();
      });
    }
    if (status && status.getAttribute('data-bound') !== '1') {
      status.setAttribute('data-bound', '1');
      status.addEventListener('change', function () {
        usersFilterStatus = String(status.value || 'all');
        var listHost = qs('#usersListHost', main);
        if (listHost) listHost.innerHTML = usersListHtml(filterUsersList());
        bindUsersListItemEvents(main);
        refreshIcons();
      });
    }
    if (started && started.getAttribute('data-bound') !== '1') {
      started.setAttribute('data-bound', '1');
      started.addEventListener('change', function () {
        usersFilterStarted = String(started.value || 'all');
        var listHost = qs('#usersListHost', main);
        if (listHost) listHost.innerHTML = usersListHtml(filterUsersList());
        bindUsersListItemEvents(main);
        refreshIcons();
      });
    }
    if (channel && channel.getAttribute('data-bound') !== '1') {
      channel.setAttribute('data-bound', '1');
      channel.addEventListener('change', function () {
        usersFilterChannel = String(channel.value || 'all');
        var listHost = qs('#usersListHost', main);
        if (listHost) listHost.innerHTML = usersListHtml(filterUsersList());
        bindUsersListItemEvents(main);
        refreshIcons();
      });
    }
    bindUsersListItemEvents(main);
  }

  function renderUsers() {
    var main = qs('#mainContent');
    if (!main) return;
    main.innerHTML = skeletonPage();
    getJson('/users')
      .then(function (data) {
        if (currentRoute !== 'users') return;
        usersCache = (data && data.users) || [];
        if (!selectedUserId && usersCache.length) {
          selectedUserId = usersCache[0].user_id;
        }
        if (selectedUserId && !usersCache.some(function (u) { return u.user_id === selectedUserId; })) {
          selectedUserId = usersCache.length ? usersCache[0].user_id : null;
        }
        var filtered = filterUsersList();
        var html = '<section class="users-page">';
        html += '<div class="panel users-toolbar">';
        html += '<div class="search-bar">';
        html += '<input id="usersSearch" class="input" placeholder="Поиск по ID, имени, роли, каналу" value="' + esc(usersFilterQuery) + '" />';
        html += '<select id="usersStatusFilter" class="select"><option value="all"' + (usersFilterStatus === 'all' ? ' selected' : '') + '>Все</option><option value="active"' + (usersFilterStatus === 'active' ? ' selected' : '') + '>Только активные</option><option value="restricted"' + (usersFilterStatus === 'restricted' ? ' selected' : '') + '>Только ограниченные</option></select>';
        html += '<select id="usersStartedFilter" class="select"><option value="all"' + (usersFilterStarted === 'all' ? ' selected' : '') + '>Все (старт бота)</option><option value="started"' + (usersFilterStarted === 'started' ? ' selected' : '') + '>Бот запускали</option><option value="not_started"' + (usersFilterStarted === 'not_started' ? ' selected' : '') + '>Бот не запускали</option></select>';
        html += '<select id="usersChannelFilter" class="select">' + usersChannelFilterOptionsHtml() + '</select>';
        html += '</div>';
        html += '<div class="text-sm text-secondary">Всего: ' + esc(String(usersCache.length)) + ', в выдаче: ' + esc(String(filtered.length)) + '</div>';
        html += '</div>';
        html += '<div class="panel panel-flush users-split">';
        html += '<aside class="users-list-pane"><div id="usersListHost" class="users-list-host">' + usersListHtml(filtered) + '</div></aside>';
        html += '<section id="usersDetail" class="users-detail-pane"></section>';
        html += '</div></section>';
        main.innerHTML = html;
        bindUsersPageEvents();
        renderUserDetail(selectedUserId);
        refreshIcons();
      })
      .catch(function (err) {
        if (err && err.message === 'auth') return;
        main.innerHTML = '<p class="muted">Не удалось загрузить пользователей</p>';
      });
  }

  var LOG_LEVEL_LABELS = {
    INFO: 'Инфо',
    WARN: 'Внимание',
    ERROR: 'Ошибка',
    DEBUG: 'Отладка',
    UNKNOWN: 'Прочее',
  };

  function formatLogTimestamp(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    if (Number.isNaN(d.getTime())) return String(ts);
    return d.toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  function formatLogExtra(extra) {
    if (extra === undefined || extra === null) return '';
    if (typeof extra === 'string') return extra;
    try {
      return JSON.stringify(extra, null, 2);
    } catch (_e) {
      return String(extra);
    }
  }

  function formatLogEntryForCopy(entry) {
    var level = entry.level || 'UNKNOWN';
    var ts = entry.ts || '';
    var msg = entry.message || entry.raw || '';
    var extraText = formatLogExtra(entry.extra);
    var lines = [];
    lines.push('[' + (ts || '—') + '] ' + level);
    lines.push(msg);
    if (extraText) {
      lines.push('');
      lines.push('--- details ---');
      lines.push(extraText);
    }
    if (entry.raw && entry.raw !== msg && entry.raw !== JSON.stringify(entry)) {
      lines.push('');
      lines.push('--- raw ---');
      lines.push(String(entry.raw));
    }
    return lines.join('\n');
  }

  function highlightLogText(text, needle) {
    var safe = esc(String(text || ''));
    if (!needle) return safe;
    var n = String(needle).toLowerCase();
    if (!n) return safe;
    var src = String(text || '');
    var lower = src.toLowerCase();
    var out = '';
    var i = 0;
    while (true) {
      var idx = lower.indexOf(n, i);
      if (idx === -1) {
        out += esc(src.slice(i));
        break;
      }
      out += esc(src.slice(i, idx));
      out += '<mark class="log-hl">' + esc(src.slice(idx, idx + n.length)) + '</mark>';
      i = idx + n.length;
    }
    return out;
  }

  function logEntryHtml(entry, filter) {
    var level = entry.level || 'UNKNOWN';
    var label = LOG_LEVEL_LABELS[level] || level;
    var extraText = formatLogExtra(entry.extra);
    var copyPayload = formatLogEntryForCopy(entry);
    var html =
      '<article class="log-entry level-' +
      esc(level.toLowerCase()) +
      '">' +
      '<div class="log-entry-head">' +
      '<time class="log-time mono" datetime="' +
      esc(entry.ts || '') +
      '">' +
      esc(formatLogTimestamp(entry.ts)) +
      '</time>' +
      '<span class="log-badge">' +
      esc(label) +
      '</span>' +
      '<div class="log-entry-actions">' +
      '<button type="button" class="btn btn-ghost btn-sm log-copy-btn" data-copy-log-entry title="Скопировать запись целиком">' +
      '<i data-lucide="copy"></i> Копировать</button>' +
      '</div>' +
      '</div>' +
      '<textarea class="log-copy-payload" readonly tabindex="-1" aria-hidden="true">' +
      escTextarea(copyPayload) +
      '</textarea>' +
      '<p class="log-message">' +
      highlightLogText(entry.message || entry.raw || '', filter) +
      '</p>';
    if (extraText) {
      var lineCount = extraText.split('\n').length;
      var useDetails = extraText.length > 120 || lineCount > 6;
      if (useDetails) {
        html +=
          '<details class="log-extra-wrap"><summary class="log-extra-summary">Детали (' +
          esc(String(lineCount)) +
          ' строк)</summary>' +
          '<div class="log-extra-toolbar">' +
          '<button type="button" class="btn btn-ghost btn-sm log-copy-btn" data-copy-log-entry title="Скопировать сообщение и детали ошибки">' +
          '<i data-lucide="copy"></i> Копировать ошибку</button>' +
          '</div>' +
          '<pre class="log-extra mono">' +
          esc(extraText) +
          '</pre></details>';
      } else {
        html += '<pre class="log-extra mono">' + esc(extraText) + '</pre>';
      }
    }
    html += '</article>';
    return html;
  }

  function bindLogViewer(body) {
    if (!body || body.getAttribute('data-log-bound') === '1') return;
    body.setAttribute('data-log-bound', '1');
    body.addEventListener('click', function (ev) {
      var btn = ev.target.closest('[data-copy-log-entry]');
      if (!btn || !body.contains(btn)) return;
      ev.preventDefault();
      ev.stopPropagation();
      var article = btn.closest('.log-entry');
      if (!article) return;
      var ta = qs('.log-copy-payload', article);
      var text = ta ? ta.value : '';
      if (!text) {
        var msg = qs('.log-message', article);
        var extra = qs('.log-extra', article);
        var time = qs('.log-time', article);
        text = (time ? time.getAttribute('datetime') || time.textContent : '') + '\n' + (msg ? msg.textContent : '');
        if (extra) text += '\n\n--- details ---\n' + extra.textContent;
      }
      copyTextToClipboard(text, 'Запись скопирована — можно вставить в анализ');
    });
  }

  function logAiStatusLabel(status) {
    if (status === 'ok') return 'В норме';
    if (status === 'critical') return 'Критично';
    return 'Нужно внимание';
  }

  function logAiSeverityLabel(severity) {
    if (severity === 'critical') return 'Критично';
    if (severity === 'warning') return 'Внимание';
    return 'Инфо';
  }

  function renderLogAiReport(report, root) {
    var panel = qs('#log_ai_report', root);
    if (!panel || !report) return;
    var score = typeof report.health_score === 'number' ? report.health_score : 0;
    var status = report.status || 'attention';
    var html = '<div class="log-ai-head">';
    html += '<div class="log-ai-score log-ai-score-' + esc(status) + '" title="Оценка здоровья проекта">' + esc(String(score)) + '</div>';
    html += '<div class="log-ai-head-text">';
    html += '<div class="log-ai-status log-ai-status-' + esc(status) + '">' + esc(logAiStatusLabel(status)) + '</div>';
    html += '<p class="log-ai-summary">' + esc(report.summary || '') + '</p>';
    html += '<div class="log-ai-meta muted text-sm">Проанализировано записей: ' + esc(String(report.logs_analyzed || 0));
    if (report.model) html += ' · модель: ' + esc(report.model);
    if (report.analyzed_at) html += ' · ' + esc(fmtDateTime(report.analyzed_at));
    html += '</div></div>';
    html += '<div class="log-ai-head-actions">';
    html += '<button type="button" class="btn btn-ghost btn-sm" id="log_ai_copy"><i data-lucide="copy"></i> Копировать</button>';
    html += '<button type="button" class="btn btn-ghost btn-sm" id="log_ai_close"><i data-lucide="x"></i></button>';
    html += '</div></div>';

    var problems = Array.isArray(report.problems) ? report.problems : [];
    if (problems.length) {
      html += '<div class="log-ai-section"><h4 class="log-ai-section-title"><i data-lucide="alert-circle"></i> Проблемы</h4><div class="log-ai-problems">';
      problems.forEach(function (p) {
        var sev = p.severity || 'info';
        html += '<article class="log-ai-problem log-ai-problem-' + esc(sev) + '">';
        html += '<div class="log-ai-problem-head"><span class="log-ai-badge log-ai-badge-' + esc(sev) + '">' + esc(logAiSeverityLabel(sev)) + '</span>';
        html += '<strong>' + esc(p.title || 'Проблема') + '</strong>';
        if (p.count) html += '<span class="muted text-sm">×' + esc(String(p.count)) + '</span>';
        html += '</div>';
        html += '<p>' + esc(p.description || '') + '</p>';
        if (p.what_to_do) html += '<div class="log-ai-fix"><span>Что сделать:</span> ' + esc(p.what_to_do) + '</div>';
        html += '</article>';
      });
      html += '</div></div>';
    }

    var working = Array.isArray(report.working_well) ? report.working_well : [];
    if (working.length) {
      html += '<div class="log-ai-section"><h4 class="log-ai-section-title"><i data-lucide="check-circle-2"></i> Работает нормально</h4><ul class="log-ai-list">';
      working.forEach(function (item) {
        html += '<li>' + esc(item) + '</li>';
      });
      html += '</ul></div>';
    }

    var recs = Array.isArray(report.recommendations) ? report.recommendations : [];
    if (recs.length) {
      html += '<div class="log-ai-section"><h4 class="log-ai-section-title"><i data-lucide="lightbulb"></i> Рекомендации</h4><ul class="log-ai-list log-ai-recs">';
      recs.forEach(function (item) {
        html += '<li>' + esc(item) + '</li>';
      });
      html += '</ul></div>';
    }

    panel.innerHTML = html;
    panel.hidden = false;
    refreshIcons();

    var copyBtn = qs('#log_ai_copy', panel);
    if (copyBtn) {
      copyBtn.addEventListener('click', function () {
        var text = report.summary || '';
        if (problems.length) {
          text += '\n\nПроблемы:\n';
          problems.forEach(function (p, i) {
            text += i + 1 + '. [' + logAiSeverityLabel(p.severity) + '] ' + (p.title || '') + '\n';
            text += (p.description || '') + '\n';
            if (p.what_to_do) text += 'Что сделать: ' + p.what_to_do + '\n';
          });
        }
        if (recs.length) {
          text += '\nРекомендации:\n' + recs.map(function (r, i) { return i + 1 + '. ' + r; }).join('\n');
        }
        copyTextToClipboard(text, 'Отчёт скопирован');
      });
    }
    var closeBtn = qs('#log_ai_close', panel);
    if (closeBtn) {
      closeBtn.addEventListener('click', function () {
        panel.hidden = true;
      });
    }
  }

  function renderAiOperatorModelFields(presets, provider, currentModel) {
    var preset = presets && presets[provider] ? presets[provider] : {};
    var models = Array.isArray(preset.models) ? preset.models : [];
    var current = currentModel || preset.default_model || '';
    var isCustom = current && models.indexOf(current) === -1;
    var html = '<div class="form-group"><label>Модель</label>';
    if (provider === 'custom') {
      html +=
        '<input class="input mono" id="set_ai_model_custom" value="' +
        esc(current) +
        '" placeholder="название-модели"/>';
      html += '<input type="hidden" id="set_ai_model" value="' + esc(current) + '"/>';
    } else {
      html += '<select class="select" id="set_ai_model_select">';
      models.forEach(function (m) {
        html += '<option value="' + esc(m) + '"' + (m === current && !isCustom ? ' selected' : '') + '>' + esc(m) + '</option>';
      });
      html += '<option value="__custom__"' + (isCustom ? ' selected' : '') + '>Другая модель…</option>';
      html += '</select>';
      html +=
        '<input class="input mono" id="set_ai_model_custom" value="' +
        esc(isCustom ? current : '') +
        '" placeholder="Введите ID модели" style="margin-top:0.45rem;' +
        (isCustom ? '' : 'display:none') +
        '"/>';
      html += '<input type="hidden" id="set_ai_model" value="' + esc(current) + '"/>';
    }
    if (provider === 'openrouter') {
      html +=
        '<p class="muted text-sm" style="margin-top:0.35rem">Каталог: <a href="https://openrouter.ai/models" target="_blank" rel="noopener">openrouter.ai/models</a></p>';
    }
    html += '</div>';
    return html;
  }

  function renderAiOperatorPanel(ai) {
    var provider = (ai && ai.provider) || 'openrouter';
    var presets = (ai && ai.presets) || {};
    var preset = presets[provider] || presets.openrouter || {};
    var configured = !!(ai && ai.configured);
    var html = '<div class="panel ai-operator-panel" id="ai_operator_panel" style="margin-bottom:0.75rem">';
    html += sectionHead('Оператор ИИ', 'Ключ и модель для ИИ-анализа логов');
    html +=
      '<div class="ai-operator-status ' +
      (configured ? 'is-ok' : 'is-off') +
      '"><span class="ai-operator-status-dot"></span>' +
      (configured
        ? esc((ai.provider_label || preset.label || 'Оператор') + ' подключён')
        : 'Оператор не настроен') +
      '</div>';

    if (configured) {
      html += '<dl class="settings-summary-list ai-operator-summary">';
      html += settingsSummaryRow('Оператор', ai.provider_label || preset.label || provider);
      html += settingsSummaryRow('Модель', ai.model || '—');
      html += settingsSummaryRow('Base URL', ai.base_url || '—');
      if (ai.api_key_preview) html += settingsSummaryRow('Ключ', ai.api_key_preview);
      html += '</dl>';
    }

    html += '<div class="form-group"><label>Оператор</label>';
    html += '<select class="select" id="set_ai_provider">';
    html += '<option value="openrouter"' + (provider === 'openrouter' ? ' selected' : '') + '>OpenRouter</option>';
    html += '<option value="openai"' + (provider === 'openai' ? ' selected' : '') + '>OpenAI</option>';
    html += '<option value="custom"' + (provider === 'custom' ? ' selected' : '') + '>Свой API (OpenAI-совместимый)</option>';
    html += '</select></div>';

    html += '<div class="form-group"><label>API-ключ</label>';
    html +=
      '<input class="input mono" id="set_ai_key" type="password" autocomplete="new-password" placeholder="' +
      (configured ? 'Оставьте пустым, чтобы не менять' : provider === 'openai' ? 'sk-…' : 'sk-or-v1-…') +
      '"/>';
    if (preset.docs_url) {
      html +=
        '<p class="muted text-sm" style="margin-top:0.35rem"><a href="' +
        esc(preset.docs_url) +
        '" target="_blank" rel="noopener">Получить ключ</a></p>';
    }
    html += '</div>';

    html += '<div class="form-group" id="set_ai_base_wrap"' + (provider === 'custom' ? '' : ' hidden') + '>';
    html += '<label>Base URL</label>';
    html +=
      '<input class="input mono" id="set_ai_base" value="' +
      esc(ai.base_url || preset.base_url || '') +
      '" placeholder="https://…/v1"/></div>';

    html += '<div id="set_ai_model_fields">';
    html += renderAiOperatorModelFields(presets, provider, ai.model || preset.default_model || '');
    html += '</div>';

    html += '<div id="set_ai_test_result" class="ai-operator-test-result" hidden></div>';
    html += '<div class="ai-operator-actions">';
    html += '<button type="button" class="btn btn-primary" id="set_save_ai"><i data-lucide="save"></i> Сохранить</button>';
    html += '<button type="button" class="btn btn-ghost" id="set_test_ai"><i data-lucide="plug-zap"></i> Проверить</button>';
    html += '</div>';
    html += '</div>';
    return html;
  }

  function bindAiOperatorPanel(main, ai) {
    var presets = (ai && ai.presets) || {};
    var providerEl = qs('#set_ai_provider', main);
    var baseWrap = qs('#set_ai_base_wrap', main);
    var baseEl = qs('#set_ai_base', main);
    var keyEl = qs('#set_ai_key', main);
    var testResult = qs('#set_ai_test_result', main);
    var configured = !!(ai && ai.configured);

    function getSelectedModel() {
      var provider = providerEl ? providerEl.value : 'openrouter';
      if (provider === 'custom') {
        var customOnly = qs('#set_ai_model_custom', main);
        return customOnly ? String(customOnly.value || '').trim() : '';
      }
      var selectEl = qs('#set_ai_model_select', main);
      var customEl = qs('#set_ai_model_custom', main);
      if (!selectEl) {
        var hidden = qs('#set_ai_model', main);
        return hidden ? String(hidden.value || '').trim() : '';
      }
      if (selectEl.value === '__custom__') {
        return customEl ? String(customEl.value || '').trim() : '';
      }
      return String(selectEl.value || '').trim();
    }

    function syncHiddenModelField() {
      var hidden = qs('#set_ai_model', main);
      if (hidden) hidden.value = getSelectedModel();
    }

    function bindModelControls() {
      var selectEl = qs('#set_ai_model_select', main);
      var customEl = qs('#set_ai_model_custom', main);
      if (selectEl) {
        selectEl.addEventListener('change', function () {
          if (customEl) {
            customEl.style.display = selectEl.value === '__custom__' ? '' : 'none';
            if (selectEl.value !== '__custom__') customEl.value = '';
          }
          syncHiddenModelField();
        });
      }
      if (customEl) {
        customEl.addEventListener('input', syncHiddenModelField);
      }
      syncHiddenModelField();
    }

    function replaceModelFields(nextProvider, modelValue) {
      var preset = presets[nextProvider] || {};
      var wrap = qs('#set_ai_model_fields', main);
      if (!wrap) return;
      wrap.innerHTML = renderAiOperatorModelFields(presets, nextProvider, modelValue || preset.default_model || '');
      bindModelControls();
    }

    function applyProviderPreset(nextProvider, forceDefaults) {
      var preset = presets[nextProvider] || {};
      if (baseWrap) baseWrap.hidden = nextProvider !== 'custom';
      if (baseEl && (forceDefaults || !baseEl.value.trim())) {
        baseEl.value = preset.base_url || '';
      }
      if (keyEl && forceDefaults) {
        keyEl.placeholder =
          nextProvider === 'openai' ? 'sk-…' : nextProvider === 'openrouter' ? 'sk-or-v1-…' : 'API-ключ';
      }
      if (forceDefaults) {
        replaceModelFields(nextProvider, preset.default_model || '');
      }
    }

    bindModelControls();

    if (providerEl) {
      providerEl.addEventListener('change', function () {
        applyProviderPreset(providerEl.value, true);
      });
    }

    var saveAiBtn = qs('#set_save_ai', main);
    if (saveAiBtn) {
      saveAiBtn.addEventListener('click', function () {
        syncHiddenModelField();
        var model = getSelectedModel();
        if (!model) {
          showToast('Выберите или введите модель', 'error');
          return;
        }
        var payload = {
          provider: providerEl ? providerEl.value : undefined,
          model: model,
        };
        if (providerEl && providerEl.value === 'custom' && baseEl) {
          payload.base_url = baseEl.value || undefined;
        }
        if (keyEl && String(keyEl.value || '').trim()) {
          payload.api_key = String(keyEl.value).trim();
        } else if (!configured) {
          showToast('Укажите API-ключ оператора', 'error');
          return;
        }
        postJson('/logs/ai-config', payload)
          .then(function (saved) {
            showToast('Настройки оператора сохранены', 'success');
            if (keyEl) keyEl.value = '';
            if (testResult) testResult.hidden = true;
            configured = !!saved.configured;
            var panel = qs('#ai_operator_panel', main);
            var statusEl = panel ? qs('.ai-operator-status', panel) : null;
            if (statusEl && saved.configured) {
              statusEl.className = 'ai-operator-status is-ok';
              statusEl.innerHTML =
                '<span class="ai-operator-status-dot"></span>' + esc((saved.provider_label || 'Оператор') + ' подключён');
            }
          })
          .catch(function (e) {
            showToast(e.message || 'Ошибка', 'error');
          });
      });
    }

    var testAiBtn = qs('#set_test_ai', main);
    if (testAiBtn) {
      testAiBtn.addEventListener('click', function () {
        if (testResult) {
          testResult.hidden = false;
          testResult.className = 'ai-operator-test-result is-loading';
          testResult.textContent = 'Проверяем подключение к оператору…';
        }
        testAiBtn.disabled = true;
        postJson('/logs/ai-test', {})
          .then(function (r) {
            if (testResult) {
              testResult.hidden = false;
              testResult.className = 'ai-operator-test-result is-ok';
              testResult.innerHTML =
                '<strong>Подключение успешно</strong><br><span class="muted text-sm">Ответ: ' +
                esc(r.reply || 'OK') +
                ' · ' +
                esc(r.model || '') +
                '</span>';
            }
            showToast('Оператор отвечает', 'success');
          })
          .catch(function (e) {
            if (testResult) {
              testResult.hidden = false;
              testResult.className = 'ai-operator-test-result is-error';
              testResult.innerHTML = '<strong>Ошибка подключения</strong><br><span class="muted text-sm">' + esc(e.message || 'Ошибка') + '</span>';
            }
            showToast(e.message || 'Ошибка', 'error');
          })
          .finally(function () {
            testAiBtn.disabled = false;
          });
      });
    }
  }

  function renderLogAiAnalysisControls(options) {
    options = options || {};
    var compact = !!options.compact;
    var html = '';
    if (!compact) {
      html += '<div class="panel log-ai-action-panel">';
      html += sectionHead('Анализ журнала', 'ИИ прочитает логи и метрики БД, выдаст отчёт на русском');
    } else {
      html += '<div class="log-ai-action-panel log-ai-action-panel--inline">';
    }
    html += '<div class="log-ai-action-row">';
    if (!compact) {
      html +=
        '<select class="select" id="log_level" style="max-width:150px"><option value="">Все уровни</option>' +
        '<option value="ERROR">Ошибки</option><option value="WARN">Предупреждения</option>' +
        '<option value="INFO">Инфо</option><option value="DEBUG">Отладка</option></select>';
      html += '<input class="input" id="log_filter" placeholder="Поиск по тексту…" style="max-width:220px"/>';
      html +=
        '<input class="input mono" id="log_limit" style="max-width:80px" placeholder="200" value="' +
        esc(String(options.limit || 200)) +
        '" title="Сколько строк"/>';
    }
    html += '<select class="select" id="log_ai_focus" style="max-width:200px" title="Фокус ИИ-анализа">';
    html += '<option value="general">Общий обзор</option>';
    html += '<option value="errors">Только ошибки</option>';
    html += '<option value="comment_buttons">Кнопки комментариев</option>';
    html += '<option value="database">База данных</option>';
    html += '<option value="rate_limit">Rate limit</option>';
    html += '<option value="integrations">Интеграции</option>';
    html += '</select>';
    html +=
      '<button type="button" class="btn btn-primary" id="log_ai_run"><i data-lucide="sparkles"></i> Запустить ИИ-анализ</button>';
    if (compact) {
      html += '<a class="btn btn-ghost" href="#/settings">Настройки оператора</a>';
    }
    html += '</div>';
    html += '<div id="log_ai_report" class="log-ai-panel" hidden></div>';
    html += '</div>';
    return html;
  }

  function bindLogAiAnalysis(main, routeGuard) {
    var aiLoading = false;
    var btn = qs('#log_ai_run', main);
    if (!btn) return;
    btn.addEventListener('click', function () {
      if (aiLoading) return;
      var guardRoute = routeGuard || currentRoute;
      var levelEl = qs('#log_level', main);
      var filterEl = qs('#log_filter', main);
      var level = (levelEl && levelEl.value) || '';
      var filter = (filterEl && filterEl.value) || '';
      var lim = (qs('#log_limit', main) && qs('#log_limit', main).value) || '200';
      var focusEl = qs('#log_ai_focus', main);
      var focus = (focusEl && focusEl.value) || 'general';
      var panel = qs('#log_ai_report', main);
      aiLoading = true;
      btn.disabled = true;
      btn.innerHTML = '<span class="log-ai-spinner"></span> Анализ…';
      if (panel) {
        panel.hidden = false;
        panel.innerHTML =
          '<div class="log-ai-loading"><span class="log-ai-spinner"></span> ИИ изучает логи и метрики БД…</div>';
      }
      postJson('/logs/analyze', {
        limit: Number(lim) || 200,
        level: level || undefined,
        filter: filter || undefined,
        focus: focus,
      })
        .then(function (report) {
          if (currentRoute !== guardRoute) return;
          renderLogAiReport(report, main);
          showToast('ИИ-отчёт готов', 'success');
        })
        .catch(function (e) {
          if (currentRoute !== guardRoute) return;
          var msg = e.message || 'Ошибка анализа';
          if (panel) {
            panel.hidden = false;
            panel.innerHTML =
              '<div class="log-ai-error">' +
              '<strong>Не удалось выполнить анализ</strong>' +
              '<p>' +
              esc(msg) +
              '</p>' +
              '<p class="muted text-sm">Настройте оператора в <a href="#/settings">Настройках → Оператор ИИ</a>: ключ и модель.</p>' +
              '</div>';
          }
          showToast(msg, 'error');
        })
        .finally(function () {
          aiLoading = false;
          btn.disabled = false;
          btn.innerHTML = '<i data-lucide="sparkles"></i> Запустить ИИ-анализ';
          refreshIcons();
        });
    });
    var filterInput = qs('#log_filter', main);
    if (filterInput) {
      filterInput.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') btn.click();
      });
    }
  }

  function renderAiOperatorStatusBanner(ai) {
    var preset = (ai && ai.presets && ai.presets[ai.provider]) || {};
    if (!ai || !ai.configured) {
      return (
        '<div class="panel" style="margin-bottom:0.75rem;border-color:color-mix(in srgb, var(--warning) 40%, var(--border))">' +
        '<p class="muted text-sm" style="margin:0">Оператор не настроен. Укажите ключ и модель в <a href="#/settings">Настройках → Оператор ИИ</a>, затем вернитесь сюда.</p>' +
        '</div>'
      );
    }
    return (
      '<p class="text-sm muted" style="margin-bottom:0.75rem">' +
      'Оператор: <strong>' +
      esc(ai.provider_label || preset.label || ai.provider || '—') +
      '</strong>, модель <strong>' +
      esc(ai.model || '—') +
      '</strong>. <a href="#/settings">Изменить в настройках</a>' +
      '</p>'
    );
  }

  function renderAiLogPage() {
    var main = qs('#mainContent');
    if (!main) return;
    main.innerHTML = skeletonPage();
    getJson('/logs/ai-config')
      .then(function (ai) {
        if (currentRoute !== 'ailog') return;
        var html = renderAiOperatorStatusBanner(ai || {});
        html += renderLogAiAnalysisControls({ limit: 200, compact: false });
        main.innerHTML = html;
        bindLogAiAnalysis(main, 'ailog');
        refreshIcons();
      })
      .catch(function (e) {
        if (currentRoute !== 'ailog') return;
        main.innerHTML =
          '<p class="muted">Не удалось загрузить настройки ИИ: ' + esc(e.message || 'ошибка') + '</p>';
      });
  }

  function renderLogs() {
    var main = qs('#mainContent');
    if (!main) return;
    clearLogsTimer();
    main.innerHTML =
      '<p class="text-sm muted">Журнал работы бота: события, предупреждения и ошибки. Новые записи сверху.</p>' +
      '<div id="db_stats_bar" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px;padding:10px 12px;background:var(--surface-2,#f4f5f7);border-radius:8px;font-size:13px;align-items:center">' +
      '<span style="font-weight:600;color:var(--text-2,#555)">БД:</span>' +
      '<span id="dbs_posts" class="log-stat" title="Всего постов в БД">📄 посты: <strong>…</strong></span>' +
      '<span id="dbs_pending" class="log-stat" title="Посты без кнопки (pending)">⏳ без кнопки: <strong>…</strong></span>' +
      '<span id="dbs_channels" class="log-stat" title="Активных каналов">📡 каналы: <strong>…</strong></span>' +
      '<span id="dbs_comments" class="log-stat" title="Комментариев">💬 коммент: <strong>…</strong></span>' +
      '<span id="dbs_retry" class="log-stat" title="В очереди повторной привязки кнопки">🔄 ретрай: <strong>…</strong></span>' +
      '<span id="dbs_auto_recovery" class="log-stat" title="Автовосстановление ссылок по лог-сигналам">🛠 авто-восст.: <strong>…</strong></span>' +
      '<button type="button" class="btn btn-ghost btn-sm" id="dbs_refresh" style="margin-left:auto">↻ Обновить</button>' +
      '</div>' +
      '<div class="search-bar log-toolbar">' +
      '<select class="select" id="log_level" style="max-width:150px"><option value="">Все уровни</option>' +
      '<option value="ERROR">Ошибки</option>' +
      '<option value="WARN">Предупреждения</option>' +
      '<option value="INFO">Инфо</option>' +
      '<option value="DEBUG">Отладка</option>' +
      '</select>' +
      '<input class="input" id="log_filter" placeholder="Поиск по тексту…" style="max-width:220px"/>' +
      '<input class="input mono" id="log_limit" style="max-width:80px" placeholder="200" value="200" title="Сколько строк"/>' +
      '<label class="log-auto-label"><input type="checkbox" id="log_auto" checked/> Авто 5 с</label>' +
      '<button type="button" class="btn btn-primary" id="log_run">Обновить</button>' +
      '</div>' +
      renderLogAiAnalysisControls({ limit: 200, compact: true }) +
      '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px">' +
      '<button type="button" class="btn btn-ghost btn-sm log-quick-filter" data-filter="db:">🗄 БД</button>' +
      '<button type="button" class="btn btn-ghost btn-sm log-quick-filter" data-filter="commentButton">🔘 Кнопки</button>' +
      '<button type="button" class="btn btn-ghost btn-sm log-quick-filter" data-filter="attach_failed">❌ attach_failed</button>' +
      '<button type="button" class="btn btn-ghost btn-sm log-quick-filter" data-filter="commentButtonRetry">🔄 Ретрай</button>' +
      '<button type="button" class="btn btn-ghost btn-sm log-quick-filter" data-filter="rate limit">⚡ Rate limit</button>' +
      '<button type="button" class="btn btn-ghost btn-sm log-quick-filter" data-filter="postStore.savePost">💾 savePost</button>' +
      '<button type="button" class="btn btn-ghost btn-sm log-quick-filter" data-filter="" data-level="ERROR">🔴 Все ошибки</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" id="log_clear_filter" title="Сбросить фильтры">✕ Сброс</button>' +
      '</div>' +
      '<div class="log-stats" id="log_stats"></div>' +
      '<div class="log-viewer" id="log_body"></div>';
    var loading = false;

    function renderStats(stats) {
      var el = qs('#log_stats', main);
      if (!el || !stats) return;
      el.innerHTML =
        '<span class="log-stat">Всего: <strong>' +
        esc(String(stats.total || 0)) +
        '</strong></span>' +
        '<span class="log-stat stat-info">Инфо: <strong>' +
        esc(String(stats.info || 0)) +
        '</strong></span>' +
        '<span class="log-stat stat-warn">Внимание: <strong>' +
        esc(String(stats.warn || 0)) +
        '</strong></span>' +
        '<span class="log-stat stat-error">Ошибки: <strong>' +
        esc(String(stats.error || 0)) +
        '</strong></span>' +
        (stats.debug
          ? '<span class="log-stat stat-debug">Отладка: <strong>' + esc(String(stats.debug)) + '</strong></span>'
          : '');
    }

    function run(silent) {
      if (loading) return;
      var level = (qs('#log_level', main) && qs('#log_level', main).value) || '';
      var filter = (qs('#log_filter', main) && qs('#log_filter', main).value) || '';
      var lim = (qs('#log_limit', main) && qs('#log_limit', main).value) || '200';
      var q =
        '/logs?limit=' +
        encodeURIComponent(lim) +
        (level ? '&level=' + encodeURIComponent(level) : '') +
        (filter ? '&filter=' + encodeURIComponent(filter) : '');
      var body = qs('#log_body', main);
      if (!body) return;
      var atTop = body.scrollTop <= 8;
      if (!silent) body.innerHTML = '<p class="muted log-loading">Загрузка…</p>';
      loading = true;
      getJson(q)
        .then(function (data) {
          if (currentRoute !== 'logs') return;
          var entries = data.entries || [];
          if (!entries.length && data.lines && data.lines.length) {
            entries = data.lines.map(function (line) {
              return { ts: '', level: 'UNKNOWN', message: line, raw: line };
            });
          }
          renderStats(data.stats);
          if (!entries.length) {
            body.innerHTML = '<p class="muted log-empty">Нет записей по выбранным фильтрам</p>';
            return;
          }
          var html = '';
          entries
            .slice()
            .reverse()
            .forEach(function (entry) {
              html += logEntryHtml(entry, filter);
            });
          body.innerHTML = html;
          refreshIcons();
          if (atTop || !silent) {
            body.scrollTop = 0;
          }
        })
        .catch(function (e) {
          if (currentRoute !== 'logs') return;
          body.innerHTML =
            '<p class="log-empty" style="color:var(--danger)">' + esc(e.message || 'Ошибка загрузки') + '</p>';
        })
        .finally(function () {
          loading = false;
        });
    }

    var logBody = qs('#log_body', main);
    if (logBody) bindLogViewer(logBody);

    function scheduleLogsRefresh() {
      clearLogsTimer();
      var auto = qs('#log_auto', main);
      if (!auto || !auto.checked) return;
      logsRefreshTimer = window.setInterval(function () {
        if (currentRoute === 'logs') run(true);
      }, 5000);
    }

    function loadDbStats() {
      getJson('/db-stats')
        .then(function (d) {
          var posts = qs('#dbs_posts', main);
          var pending = qs('#dbs_pending', main);
          var channels = qs('#dbs_channels', main);
          var comments = qs('#dbs_comments', main);
          var retry = qs('#dbs_retry', main);
          var autoRecovery = qs('#dbs_auto_recovery', main);
          if (posts) posts.querySelector('strong').textContent = String(d.posts ?? '?');
          if (pending) {
            var n = d.pending_buttons ?? 0;
            pending.querySelector('strong').textContent = String(n);
            pending.style.color = n > 0 ? 'var(--warning,#e07b00)' : '';
          }
          if (channels) channels.querySelector('strong').textContent = String(d.channels ?? '?');
          if (comments) comments.querySelector('strong').textContent = String(d.comments ?? '?');
          if (retry) {
            var nr = d.retry_queue ?? 0;
            retry.querySelector('strong').textContent = String(nr);
            retry.style.color = nr > 0 ? 'var(--warning,#e07b00)' : '';
          }
          if (autoRecovery) {
            var ar = d.auto_recovery || {};
            var todayRecovered = typeof ar.today_recovered === 'number' ? ar.today_recovered : 0;
            var todayFailed = typeof ar.today_failed === 'number' ? ar.today_failed : 0;
            var totalRecovered = typeof ar.total_recovered === 'number' ? ar.total_recovered : 0;
            var totalFailed = typeof ar.total_failed === 'number' ? ar.total_failed : 0;
            autoRecovery.querySelector('strong').textContent =
              String(todayRecovered) + ' / ' + String(todayFailed);
            autoRecovery.title =
              'Сегодня: восстановлено ' +
              todayRecovered +
              ', не удалось ' +
              todayFailed +
              '. Всего: восстановлено ' +
              totalRecovered +
              ', не удалось ' +
              totalFailed;
            autoRecovery.style.color = todayFailed > 0 ? 'var(--warning,#e07b00)' : '';
          }
        })
        .catch(function () {});
    }

    var dbsRefreshBtn = qs('#dbs_refresh', main);
    if (dbsRefreshBtn) dbsRefreshBtn.addEventListener('click', loadDbStats);
    loadDbStats();

    qsa('.log-quick-filter', main).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var filterVal = btn.getAttribute('data-filter') || '';
        var levelVal = btn.getAttribute('data-level') || '';
        var filterEl2 = qs('#log_filter', main);
        var levelEl = qs('#log_level', main);
        if (filterEl2) filterEl2.value = filterVal;
        if (levelEl) levelEl.value = levelVal;
        run(false);
      });
    });

    var clearFilterBtn = qs('#log_clear_filter', main);
    if (clearFilterBtn) {
      clearFilterBtn.addEventListener('click', function () {
        var filterEl2 = qs('#log_filter', main);
        var levelEl = qs('#log_level', main);
        if (filterEl2) filterEl2.value = '';
        if (levelEl) levelEl.value = '';
        run(false);
      });
    }

    qs('#log_run', main).addEventListener('click', function () {
      run(false);
    });
    bindLogAiAnalysis(main, 'logs');
    var autoEl = qs('#log_auto', main);
    if (autoEl) {
      autoEl.addEventListener('change', scheduleLogsRefresh);
    }
    var filterEl = qs('#log_filter', main);
    if (filterEl) {
      filterEl.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') run(false);
      });
    }
    run(false);
    scheduleLogsRefresh();
    refreshIcons();
  }

  function renderSettings() {
    var main = qs('#mainContent');
    if (!main) return;
    main.innerHTML = skeletonPage();
    getJson('/settings')
      .then(function (s) {
        if (currentRoute !== 'settings') return;
        var logAi = (s && s.log_ai) || {};
        if (!logAi.presets) {
          return getJson('/logs/ai-config')
            .catch(function () {
              return logAi;
            })
            .then(function (aiCfg) {
              if (currentRoute !== 'settings') return;
              paintSettingsPage(main, s, aiCfg && aiCfg.presets ? aiCfg : logAi);
            });
        }
        paintSettingsPage(main, s, logAi);
      })
      .catch(function () {
        main.innerHTML = '<p class="muted">Ошибка загрузки</p>';
      });
  }

  function paintSettingsPage(main, s, logAi) {
        var sec = s.poll_interval_sec != null ? s.poll_interval_sec : 30;
        var html = '<div class="two-col">';

        html += '<div>';
        html += '<div class="panel" style="margin-bottom:0.75rem">';
        html += sectionHead('Основные', 'Параметры работы бота');
        html += '<div class="form-group"><label>Интервал опроса каналов (сек)</label>';
        html +=
          '<input class="input" id="set_poll" type="number" step="1" min="1" value="' +
          esc(String(sec)) +
          '"/></div>';
        html += '<div class="form-group"><label>Никнейм бота</label>';
        html +=
          '<input class="input" value="' +
          esc(s.bot_nickname || '—') +
          '" readonly style="color:var(--text-muted);cursor:default"/></div>';
        html += '<button type="button" class="btn btn-primary" id="set_save_poll"><i data-lucide="save"></i> Сохранить</button>';
        html += '</div>';

        html += renderAiOperatorPanel(logAi);

        html += '<div class="panel" style="margin-top:0.75rem">';
        html += sectionHead('Уведомления', 'Когда получать оповещения');
        html += toggleRow('notify_errors', 'Уведомлять об ошибках', 'Критические сбои в работе бота', true);
        html += toggleRow('notify_antispam', 'Блокировки антиспама', 'При срабатывании фильтров', false);
        html += toggleRow('notify_subscribers', 'Новые подписчики', 'Каждый новый пользователь', false);
        html += '</div>';
        html += '</div>';

        html += '<div>';
        html += '<div class="panel panel-danger" style="border-color:rgba(239,68,68,0.3)">';
        html += '<div class="content-block-head"><div><h3 style="color:var(--danger)"><i data-lucide="alert-triangle" style="width:14px;height:14px;vertical-align:-2px;margin-right:4px"></i>Опасная зона</h3>';
        html += '<p class="block-desc">Необратимые операции — только при необходимости</p></div></div>';

        html += '<div class="danger-zone-item">';
        html += '<div class="danger-zone-item-title">Сбросить посты и комментарии</div>';
        html += '<div class="danger-zone-item-desc">Удалятся все посты и комментарии из локальной базы.</div>';
        html += '<button type="button" class="btn btn-danger btn-sm" id="set_reset_posts"><i data-lucide="trash-2"></i> Сбросить посты</button>';
        html += '</div>';

        html += '<div class="danger-zone-item">';
        html += '<div class="danger-zone-item-title">Сбросить подписчиков</div>';
        html += '<div class="danger-zone-item-desc">Список подписчиков бота будет очищен.</div>';
        html += '<button type="button" class="btn btn-danger btn-sm" id="set_reset_subs"><i data-lucide="trash-2"></i> Сбросить подписчиков</button>';
        html += '</div>';
        html += '</div>';

        html += '</div>';
        main.innerHTML = html;
        bindToggleRows(main, null);
        bindAiOperatorPanel(main, logAi);
        qs('#set_save_poll', main).addEventListener('click', function () {
          var v = Number(qs('#set_poll', main).value);
          postJson('/settings', { poll_interval: v })
            .then(function () {
              showToast('Интервал обновлён', 'success');
            })
            .catch(function (e) {
              showToast(e.message || 'Ошибка', 'error');
            });
        });
        qs('#set_reset_posts', main).addEventListener('click', function () {
          showConfirm('Сбросить посты?', 'Удалятся все посты и комментарии из локальной базы.', function () {
            postJson('/reset', { target: 'posts' })
              .then(function () {
                showToast('Сброшено', 'success');
              })
              .catch(function (e) {
                showToast(e.message || 'Ошибка', 'error');
              });
          });
        });
        qs('#set_reset_subs', main).addEventListener('click', function () {
          showConfirm('Сбросить подписчиков?', 'Список подписчиков бота будет очищен.', function () {
            postJson('/reset', { target: 'subscribers' })
              .then(function () {
                showToast('Сброшено', 'success');
              })
              .catch(function (e) {
                showToast(e.message || 'Ошибка', 'error');
              });
          });
        });
        refreshIcons();
  }

  function renderTopbarForRoute() {
    if (currentRoute === 'dashboard') {
      var periodValue = dashPeriodDays;
      setTopbarActions(
        '<div class="period-tabs">' +
          '<button type="button" class="period-tab' +
          (periodValue === 7 ? ' active' : '') +
          '" data-days="7">7 дн.</button>' +
          '<button type="button" class="period-tab' +
          (periodValue === 30 ? ' active' : '') +
          '" data-days="30">30 дн.</button>' +
          '<button type="button" class="period-tab' +
          (periodValue === 0 ? ' active' : '') +
          '" data-days="0">Всё время</button></div>',
      );
      var tb = qs('#topbarActions');
      if (tb) {
        qsa('.period-tab', tb).forEach(function (b) {
          b.addEventListener('click', function () {
            var picked = Number(b.getAttribute('data-days'));
            if (currentRoute === 'dashboard') {
              dashPeriodDays = picked;
              renderTopbarForRoute();
              renderDashboard(true);
            }
          });
        });
      }
    } else if (currentRoute === 'users') {
      setTopbarActions(
        '<button type="button" class="btn btn-ghost btn-sm" id="usersSyncBtn"><i data-lucide="refresh-cw"></i> Обновить подписчиков каналов</button>',
      );
      var syncBtn = qs('#usersSyncBtn');
      if (syncBtn) {
        syncBtn.addEventListener('click', function () {
          syncBtn.disabled = true;
          postJson('/users/sync-channel-subscribers', {})
            .then(function (data) {
              var synced = Number(data && data.synced_channels ? data.synced_channels : 0);
              var failed = Number(data && data.failed_channels ? data.failed_channels : 0);
              var members = Number(data && data.members_total ? data.members_total : 0);
              showToast(
                'Синхронизация завершена: каналов ' +
                  synced +
                  ', участников ' +
                  members +
                  (failed > 0 ? ', ошибок ' + failed : ''),
                failed > 0 ? 'info' : 'success',
              );
              renderUsers();
            })
            .catch(function (e) {
              showToast(e.message || 'Не удалось синхронизировать подписчиков', 'error');
            })
            .finally(function () {
              syncBtn.disabled = false;
            });
        });
      }
    } else {
      setTopbarActions('');
    }
  }

  function handleRoute() {
    var prev = currentRoute;
    var next = parseHashRoute();
    if (prev === 'channelimport' && next !== 'channelimport') {
      clearChannelImportPoll();
    }
    if (next !== currentRoute) {
      clearDashTimer();
      clearLogsTimer();
    }
    currentRoute = next;
    var rawHash = (location.hash || '').replace(/^#/, '').trim();
    var hashBase = rawHash.split(/[/?]/)[0];
    if (hashBase !== currentRoute) {
      location.hash = currentRoute;
    }
    setPageTitle();
    renderSidebar();
    renderTopbarForRoute();
    if (currentRoute === 'dashboard') {
      scheduleDashRefresh();
      renderDashboard(true);
    } else if (currentRoute === 'channels') {
      renderChannels();
    } else if (currentRoute === 'tgchains') {
      renderTgChains();
    } else if (currentRoute === 'channelimport') {
      renderChannelImport();
    } else if (currentRoute === 'autoposts') {
      renderAutoposts();
    } else if (currentRoute === 'integrations') {
      renderIntegrations();
    } else if (currentRoute === 'antispam') {
      renderAntispam();
    } else if (currentRoute === 'comments') {
      renderComments();
    } else if (currentRoute === 'users') {
      renderUsers();
    } else if (currentRoute === 'logs') {
      renderLogs();
    } else if (currentRoute === 'ailog') {
      renderAiLogPage();
    } else if (currentRoute === 'settings') {
      renderSettings();
    }
  }

  function loadBotStatus() {
    getJson('/bot-status')
      .then(function (s) {
        var el = qs('#botStatus');
        if (!el) return;
        var dot = qs('.status-dot', el);
        var labelEl = qs('.bot-status-label', el);
        var subEl = qs('.bot-status-sub', el);
        var platforms = s.platforms || {};
        var tg = platforms.telegram || {};
        var vk = platforms.vk || {};
        var ok = s.active !== false;
        if (labelEl) labelEl.textContent = s.label || (ok ? 'MAX бот активен' : 'Неактивен');
        if (subEl) {
          var parts = [];
          if (tg.label) parts.push(tg.label);
          if (typeof tg.chains_active === 'number' && tg.chains_active > 0) {
            parts.push('TG→MAX: ' + tg.chains_active);
          }
          if (vk.label) parts.push(vk.label);
          if (typeof vk.chains_active === 'number' && vk.chains_active > 0) {
            parts.push('MAX→VK: ' + vk.chains_active);
          }
          if (s.mtproto_ready === false) parts.push('MTProto: нет');
          else if (s.mtproto_ready === true) parts.push('MTProto: OK');
          subEl.textContent = parts.join(' · ');
        }
        if (dot) {
          var tgOk = tg.connected !== false;
          dot.style.background = ok && tgOk ? 'var(--success)' : ok ? 'var(--warning)' : 'var(--danger)';
        }
      })
      .catch(function () {
        var el = qs('#botStatus');
        if (!el) return;
        var labelEl = qs('.bot-status-label', el);
        var subEl = qs('.bot-status-sub', el);
        if (labelEl) labelEl.textContent = 'Нет связи с API';
        if (subEl) subEl.textContent = 'Проверьте, что бот запущен';
      });
  }

  function boot() {
    getJson('/settings')
      .then(function () {
        var app = qs('#app');
        if (app) app.classList.remove('hidden');
        var logout = qs('#logoutBtn');
        if (logout) {
          logout.addEventListener('click', function () {
            postJson('/panel-logout', {})
              .then(function () {
                window.location.href = '/admin/login';
              })
              .catch(function () {
                window.location.href = '/admin/login';
              });
          });
        }
        loadBotStatus();
        var sidebarToggle = qs('#sidebarToggle');
        var sidebarOverlay = qs('#sidebarOverlay');
        if (sidebarToggle) {
          sidebarToggle.addEventListener('click', function () {
            var sidebar = qs('#sidebar');
            if (sidebar && sidebar.classList.contains('open')) closeSidebarMobile();
            else openSidebarMobile();
          });
        }
        if (sidebarOverlay) {
          sidebarOverlay.addEventListener('click', closeSidebarMobile);
        }
        var mainEl = qs('#mainContent');
        if (mainEl && mainEl.dataset.channelNavBound !== '1') {
          mainEl.dataset.channelNavBound = '1';
          mainEl.addEventListener('click', function (e) {
            var card = e.target.closest('a.channel-card[data-chat-id]');
            if (!card) return;
            e.preventDefault();
            selectedChannelId = Number(card.getAttribute('data-chat-id'));
            location.hash = 'channels';
          });
        }
        window.addEventListener('hashchange', handleRoute);
        handleRoute();
        refreshIcons();
      })
      .catch(function () {
        /* handleAuth redirects */
      });
  }

  window.AdminShell = {
    showToast: showToast,
    showConfirm: showConfirm,
    setTopbarActions: setTopbarActions,
    getCurrentRoute: function () {
      return currentRoute;
    },
  };

  boot();
})();
