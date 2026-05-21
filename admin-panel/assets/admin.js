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
  var logsRefreshTimer = null;
  var dashPeriodDays = 7;
  var tgDashPeriodDays = 7;
  var channelsCache = [];
  var selectedChannelId = null;
  var channelDetailTab = 'stats';
  var channelSettingsEditing = false;
  var channelAntispamEditing = false;
  var commentsChatId = null;
  var commentsQuery = '';
  var usersCache = [];
  var selectedUserId = null;
  var userDetailCache = {};
  var usersFilterQuery = '';
  var usersFilterStatus = 'all';
  var usersFilterStarted = 'all';
  var usersFilterChannel = 'all';
  var channelImportPollTimer = null;
  var channelImportJobId = null;

  var NAV = [
    {
      group: 'Обзор',
      items: [
        { id: 'dashboard', label: 'MAX Дашборд', icon: 'layout-dashboard' },
        { id: 'dashboard_tg', label: 'Telegram Дашборд', icon: 'send' },
      ],
    },
    {
      group: 'Контент',
      items: [
        { id: 'channels', label: 'Каналы', icon: 'radio' },
        { id: 'tgchains', label: 'TG → MAX', icon: 'link-2' },
        { id: 'channelimport', label: 'Импорт TG→MAX', icon: 'upload-cloud' },
        { id: 'autoposts', label: 'Автопосты', icon: 'calendar-clock' },
        { id: 'comments', label: 'Комментарии', icon: 'message-square' },
      ],
    },
    {
      group: 'Модерация',
      items: [
        { id: 'integrations', label: 'Интеграции', icon: 'plug', badge: 'NEW' },
        { id: 'antispam', label: 'Антиспам', icon: 'shield' },
        { id: 'users', label: 'Пользователи', icon: 'users' },
      ],
    },
    {
      group: 'Система',
      items: [
        { id: 'logs', label: 'Логи', icon: 'terminal' },
        { id: 'settings', label: 'Настройки', icon: 'settings' },
      ],
    },
  ];

  var PAGE_TITLES = {
    dashboard: 'MAX Дашборд',
    dashboard_tg: 'Telegram Дашборд',
    channels: 'Каналы',
    tgchains: 'TG → MAX',
    channelimport: 'Импорт TG→MAX',
    autoposts: 'Автопосты',
    integrations: 'Интеграции',
    antispam: 'Антиспам',
    comments: 'Комментарии',
    users: 'Пользователи',
    logs: 'Логи',
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
    if (!editing) {
      var words = Array.isArray(settings.stopwords) ? settings.stopwords : [];
      var html = '<div class="settings-summary">';
      html += '<h3 class="settings-summary-title">Текущий антиспам</h3>';
      html += '<dl class="settings-summary-list">';
      html += settingsSummaryRow(
        'Стоп-слова',
        words.length ? words.join(', ') : '—',
      );
      html += settingsSummaryRow('Блокировать ссылки', boolLabel(!!settings.block_links));
      html += settingsSummaryRow('Защита от флуда', boolLabel(!!settings.flood_protection));
      html += settingsSummaryRow('Авто-мут', boolLabel(!!settings.auto_mute));
      html += '</dl>';
      html +=
        '<button type="button" class="btn btn-primary mt-sm" id="btnEditChannelAntispam">Изменить</button>';
      html += '</div>';
      return html;
    }
    var form = '<div class="settings-editor" id="chAntispamForm">';
    form += '<p class="muted text-sm mb-sm">Подтвердите сохранение — правила применятся к каналу.</p>';
    form += '<div class="form-group"><label>Стоп-слова канала</label>';
    form += '<div class="tags-input-wrap" id="chStopwords"></div></div>';
    form += '<div id="asToggles">';
    form += toggleRow('block_links', 'Блокировать ссылки', '', !!settings.block_links);
    form += toggleRow('flood_protection', 'Защита от флуда', '', !!settings.flood_protection);
    form += toggleRow('auto_mute', 'Авто-мут', '', !!settings.auto_mute);
    form += '</div>';
    form += '<div class="flex gap-sm mt-sm">';
    form +=
      '<button type="button" class="btn btn-ghost" id="btnCancelChannelAntispam">Отмена</button>';
    form +=
      '<button type="button" class="btn btn-primary" id="btnSaveAntispamCh">Сохранить</button>';
    form += '</div></div>';
    return form;
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
    return authFetch(apiPath(path), {
      method: 'POST',
      body: body || {},
      timeoutMs: path === '/refresh-buttons' ? 60000 : 20000,
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
      if (!r.ok) throw new Error('Ошибка');
      return r.json();
    });
  }

  function deleteReq(path) {
    return authFetch(apiPath(path), { method: 'DELETE' }).then(function (r) {
      if (!r.ok) throw new Error('Ошибка');
      return r.json();
    });
  }

  function putJsonAbs(url, body) {
    return authFetch(url, { method: 'PUT', body: body || {} }).then(function (r) {
      if (!r.ok) throw new Error('Ошибка');
      return r.json();
    });
  }

  function getJsonAbs(url) {
    return authFetch(url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function postJsonAbs(url, body) {
    return authFetch(url, { method: 'POST', body: body || {} }).then(function (r) {
      if (!r.ok) {
        return r.json().then(function (j) {
          throw new Error(j.error || 'Ошибка');
        });
      }
      return r.json();
    });
  }

  function deleteAbs(url) {
    return authFetch(url, { method: 'DELETE' }).then(function (r) {
      if (!r.ok) throw new Error('Ошибка');
      return r.json();
    });
  }

  function patchJsonAbs(url, body) {
    return authFetch(url, { method: 'PATCH', body: body || {} }).then(function (r) {
      if (!r.ok) throw new Error('Ошибка');
      return r.json();
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
    return ch.username || ch.id;
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
    panel.innerHTML =
      '<div class="tg-chats-panel-head flex-between">' +
      '<div><div class="tg-chats-title">Привязанные каналы и чаты</div>' +
      '<div class="muted text-sm">Используются в потоках, TG-цепочках и автопостинге</div></div>' +
      '<div class="tg-chats-actions"><button type="button" class="btn btn-primary btn-sm" data-refresh-tg-chats="' +
      esc(integrationId) +
      '"><i data-lucide="download"></i> Загрузить</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-refresh-tg-chats="' +
      esc(integrationId) +
      '"><i data-lucide="refresh-cw"></i> Обновить</button></div></div>' +
      (updatedAt ? '<div class="muted text-sm mb-sm">' + esc(updatedAt) + '</div>' : '') +
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
    panel.innerHTML =
      '<div class="tg-chats-panel-head flex-between">' +
      '<div><div class="tg-chats-title">Привязанные MAX-каналы</div>' +
      '<div class="muted text-sm">Каналы из реестра бота (потоки, комментарии, автопостинг)</div></div>' +
      '<div class="tg-chats-actions"><button type="button" class="btn btn-primary btn-sm" data-refresh-max-chats="1"><i data-lucide="download"></i> Загрузить</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-refresh-max-chats="1"><i data-lucide="refresh-cw"></i> Обновить</button></div></div>' +
      (updatedAt ? '<div class="muted text-sm mb-sm">' + esc(updatedAt) + '</div>' : '') +
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
              metaEl.innerHTML =
                '<span>Каналов: <strong>' +
                esc(String(n)) +
                '</strong> (админ: <strong>' +
                esc(String(admins)) +
                '</strong>)</span><span>Bot Token: <code>••••••••' +
                esc((intMaxMeta && intMaxMeta.tokenPreview) || '') +
                '</code></span>';
            }
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
    return (
      '<div class="integration-card connected"><div class="int-card-header"><div class="int-logo max">М</div><div class="int-info"><div class="int-name">MAX</div><div class="int-desc">Основная платформа — подключён</div></div><span class="int-status connected"><i data-lucide="circle-check"></i> Подключён</span></div>' +
      '<div class="int-meta" data-max-channels-meta><span>Каналов: <strong>' +
      esc(String(channels.length)) +
      '</strong>' +
      (channels.length ? ' (админ: <strong>' + esc(String(adminCount)) + '</strong>)' : '') +
      '</span><span>Bot Token: <code>••••••••' +
      esc(tokenPreview) +
      '</code></span></div>' +
      '<div class="tg-chats-panel-wrap" data-max-chats-panel="1"></div></div>'
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
    var opts = '<option value="">— выберите канал/чат —</option>';
    list.forEach(function (ch) {
      var val = telegramChannelPickValue(ch);
      var label = ch.title + (ch.username ? ' (' + ch.username + ')' : '') + ' · ' + telegramChatTypeLabel(ch.type);
      if (ch.botIsAdmin) label += ' · админ';
      opts += '<option value="' + esc(val) + '">' + esc(label) + '</option>';
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
        '" placeholder="или введите @username / -100..."/>';
    }
    return html;
  }

  function readTelegramChannelPick(selectId, manualId, root) {
    var sel = qs('#' + selectId, root);
    var manual = manualId ? qs('#' + manualId, root) : null;
    var fromManual = manual ? String(manual.value || '').trim() : '';
    if (fromManual) return fromManual;
    return sel ? String(sel.value || '').trim() : '';
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

  function refreshIcons() {
    if (typeof lucide !== 'undefined' && lucide.createIcons) {
      lucide.createIcons();
    }
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
      } else if (currentRoute === 'dashboard_tg') {
        renderTelegramDashboard(false);
      }
    }, 30000);
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
    var allowed = {
      dashboard: 1,
      dashboard_tg: 1,
      channels: 1,
      tgchains: 1,
      channelimport: 1,
      autoposts: 1,
      integrations: 1,
      antispam: 1,
      comments: 1,
      users: 1,
      logs: 1,
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
      });
    });
    refreshIcons();
  }

  function setPageTitle() {
    var t = qs('#pageTitle');
    if (t) t.textContent = PAGE_TITLES[currentRoute] || 'Панель';
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

  function renderDashboard(showLoading) {
    var main = qs('#mainContent');
    if (!main) return;
    if (showLoading !== false) {
      main.innerHTML = '<div class="dash-loading muted">Загрузка дашборда…</div>';
    }
    Promise.all([
      getJson('/dashboard?days=' + encodeURIComponent(String(dashPeriodDays))),
      getJson('/activity?limit=20'),
    ])
      .then(function (pair) {
        var d = pair[0];
        var act = pair[1];
        if (currentRoute !== 'dashboard') return;
        var eff = d.effectiveness || {};
        var score = Number(eff.score) || 0;
        var funnel = d.funnel || {};
        var totals = d.totals || {};
        var ts = d.timeseries || [];
        var chans = d.channels || [];
        var insights = eff.insights || [];
        var events = (act && act.events) || [];
        var periodLabel =
          dashPeriodDays === 0 ? 'всё время' : dashPeriodDays === 30 ? '30 дней' : '7 дней';
        var html = '';
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
        html +=
          '<div class="stat-card"><div class="label">Каналы</div><div class="value">' +
          esc(fmtNum(totals.channels)) +
          '</div><div class="sub">активных: ' +
          esc(fmtNum(totals.channels_active)) +
          '</div></div>';
        html +=
          '<div class="stat-card"><div class="label">Подписчики бота</div><div class="value">' +
          esc(fmtNum(totals.bot_subscribers)) +
          '</div><div class="sub">за период: +' +
          esc(fmtNum(totals.subscribers_in_period)) +
          '</div></div>';
        html +=
          '<div class="stat-card"><div class="label">Посты</div><div class="value">' +
          esc(fmtNum(totals.posts)) +
          '</div><div class="sub">в периоде: ' +
          esc(fmtNum(totals.posts_in_period)) +
          '</div></div>';
        html +=
          '<div class="stat-card"><div class="label">Комментарии</div><div class="value">' +
          esc(fmtNum(totals.comments)) +
          '</div><div class="sub">в периоде: ' +
          esc(fmtNum(totals.comments_in_period)) +
          '</div></div>';
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
        html += '<h3>Воронка аудитории</h3>';
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
        html += '<h3>Активность по дням (комментарии)</h3>';
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
        html += '<h3>Каналы</h3><div class="channel-cards">';
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
        html += '<h3 class="mt-md">Инсайты</h3><ul class="insights-list">';
        insights.forEach(function (line) {
          html += '<li>' + esc(line) + '</li>';
        });
        html += '</ul>';
        html += '<h3 class="mt-md">Лента активности</h3><div class="activity-feed">';
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
        html += '</div>';
        html += renderCrossBotFooter('max');
        main.innerHTML = html;
        refreshIcons();
      })
      .catch(function (err) {
        if (err && err.message === 'auth') return;
        if (currentRoute !== 'dashboard') return;
        main.innerHTML =
          '<p class="muted">Не удалось загрузить дашборд: ' + esc(err.message || String(err)) + '</p>';
      });
  }

  function renderTelegramDashboard(showLoading) {
    var main = qs('#mainContent');
    if (!main) return;
    if (showLoading !== false) {
      main.innerHTML = '<div class="dash-loading muted">Загрузка Telegram дашборда…</div>';
    }
    getJson('/dashboard-telegram?days=' + encodeURIComponent(String(tgDashPeriodDays)))
      .then(function (data) {
        if (currentRoute !== 'dashboard_tg') return;
        var totals = data.totals || {};
        var channels = data.channels || [];
        var recent = data.recent_forwarded || [];
        var html = '';
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
          html += '<p class="muted">Telegram каналы не найдены. Подключите Telegram интеграцию.</p>';
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
        html += '</div>';
        html += renderCrossBotFooter('telegram');
        main.innerHTML = html;
        refreshIcons();
      })
      .catch(function (err) {
        if (err && err.message === 'auth') return;
        if (currentRoute !== 'dashboard_tg') return;
        main.innerHTML =
          '<p class="muted">Не удалось загрузить Telegram дашборд: ' +
          esc(err.message || String(err)) +
          '</p>';
      });
  }

  function renderCrossBotFooter(currentPlatform) {
    var tgUrl = 'https://t.me/commentvmax_bot';
    var maxUrl = 'https://max.ru/id683003981770_bot';
    var isTelegram = currentPlatform === 'telegram';
    var title = isTelegram ? 'Переход в MAX-бот' : 'Переход в Telegram-бот';
    var hint = isTelegram
      ? 'Открой MAX-бот для управления MAX каналами и комментариями.'
      : 'Открой Telegram-бот для управления Telegram каналами и комментариями.';
    var primaryUrl = isTelegram ? maxUrl : tgUrl;
    var primaryLabel = isTelegram ? 'Открыть MAX-бот' : 'Открыть Telegram-бот';
    var secondaryUrl = isTelegram ? tgUrl : maxUrl;
    var secondaryLabel = isTelegram ? 'Открыть Telegram-бот' : 'Открыть MAX-бот';
    var targetBadge = isTelegram
      ? '<span class="cross-bot-platform max">MAX</span>'
      : '<span class="cross-bot-platform tg">TG</span>';
    var sourceBadge = isTelegram
      ? '<span class="cross-bot-platform tg">TG</span>'
      : '<span class="cross-bot-platform max">MAX</span>';
    return (
      '<div class="cross-bot-footer panel">' +
      '<div class="cross-bot-title-row">' +
      '<div class="cross-bot-title">🔄 ' +
      esc(title) +
      '</div>' +
      '<div class="cross-bot-route">' +
      sourceBadge +
      '<span class="cross-bot-arrow">→</span>' +
      targetBadge +
      '</div></div>' +
      '<div class="cross-bot-hint muted">' + esc(hint) + '</div>' +
      '<div class="cross-bot-actions">' +
      '<a class="btn btn-primary cross-bot-primary" target="_blank" rel="noopener noreferrer" href="' +
      esc(primaryUrl) +
      '">🚀 ' +
      esc(primaryLabel) +
      '</a>' +
      '<a class="btn btn-ghost" target="_blank" rel="noopener noreferrer" href="' +
      esc(secondaryUrl) +
      '">↔ ' +
      esc(secondaryLabel) +
      '</a></div>' +
      '<div class="cross-bot-open-note muted">Откроется в новой вкладке</div>' +
      '</div></div>'
    );
  }

  function renderChannels() {
    var main = qs('#mainContent');
    if (!main) return;
    main.innerHTML = '<div class="dash-loading muted">Загрузка каналов…</div>';
    getJson('/channels')
      .then(function (data) {
        if (currentRoute !== 'channels') return;
        channelsCache = data.channels || [];
        if (selectedChannelId && !channelsCache.some(function (c) { return c.chat_id === selectedChannelId; })) {
          selectedChannelId = null;
        }
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
            renderChannels();
          });
        });
        if (selectedChannelId) {
          return loadChannelDetail(selectedChannelId);
        }
        refreshIcons();
      })
      .catch(function (err) {
        if (err && err.message === 'auth') return;
        if (currentRoute !== 'channels') return;
        main.innerHTML =
          '<p class="muted">Ошибка: ' + esc(err.message || String(err)) + '</p>';
      });
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
                    renderChannels();
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

  function bindTgChainCard(card, chainId) {
    var activeSw = qs('[data-chain-field="active"]', card);
    if (activeSw) {
      activeSw.addEventListener('click', function (e) {
        e.stopPropagation();
        var next = !activeSw.classList.contains('on');
        patchJson('/tg-chains/' + encodeURIComponent(chainId), { active: next })
          .then(function () {
            activeSw.classList.toggle('on', next);
            card.classList.toggle('is-paused', !next);
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
  }

  function renderTgChainCardHtml(c) {
    var tg = tgChainTgDisplayName(c);
    var mx = tgChainMaxDisplayName(c);
    var html =
      '<article class="tg-chain-card' +
      (c.active ? '' : ' is-paused') +
      '" data-chain-id="' +
      esc(c.id) +
      '">';
    html += '<div class="tg-chain-card-flow">';
    html += '<div class="tg-chain-card-end"><div class="tg-chain-card-end-label">Telegram</div>';
    html += '<div class="tg-chain-card-end-name" title="' + esc(tg.title) + '">' + esc(tg.title) + '</div>';
    if (tg.sub) html += '<div class="mono text-sm muted">' + esc(tg.sub) + '</div>';
    html += '</div><span class="tg-chain-arrow">→</span>';
    html += '<div class="tg-chain-card-end"><div class="tg-chain-card-end-label">MAX</div>';
    html += '<div class="tg-chain-card-end-name" title="' + esc(mx.title) + '">' + esc(mx.title) + '</div>';
    if (mx.sub) html += '<div class="mono text-sm muted">' + esc(mx.sub) + '</div>';
    html += '</div></div>';
    html +=
      '<div class="tg-chain-card-meta"><span>Сегодня: <strong>' +
      esc(fmtNum(c.forwarded_today)) +
      '</strong> постов</span>';
    if (c.errors_today) {
      html += '<span style="color:var(--danger,#e11)"> · ошибок: ' + esc(fmtNum(c.errors_today)) + '</span>';
    }
    html += '</div><div class="tg-chain-card-actions">';
    html +=
      '<label class="tg-chain-mini-toggle"><span>Пересылка</span><span class="switch' +
      (c.active ? ' on' : '') +
      '" data-chain-field="active" role="switch" tabindex="0"></span></label>';
    html += '<div class="tg-chain-card-toggles">';
    html +=
      '<label class="tg-chain-mini-toggle"><span>Кнопка 💬</span><span class="switch' +
      (c.add_comments_button !== false ? ' on' : '') +
      '" data-chain-field="add_comments_button" role="switch" tabindex="0"></span></label>';
    html +=
      '<label class="tg-chain-mini-toggle"><span>Подпись TG</span><span class="switch' +
      (c.add_signature ? ' on' : '') +
      '" data-chain-field="add_signature" role="switch" tabindex="0"></span></label>';
    html += '</div>';
    html +=
      '<button type="button" class="btn btn-danger btn-sm" data-del-chain="' +
      esc(c.id) +
      '">Удалить</button></div></article>';
    return html;
  }

  function bindTgChainSetupPage(main) {
    var tgSel = qs('#tc_tg_select', main);
    var maxSel = qs('#tc_max', main);
    var manual = qs('#tc_tg_manual', main);
    function onPickChange() {
      updateTgChainPairPreview(main);
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
  }

  function renderTgChains() {
    var main = qs('#mainContent');
    if (!main) return;
    main.innerHTML = '<div class="dash-loading muted">Загрузка…</div>';
    Promise.all([
      getJson('/tg-chains'),
      fetchMaxLinkedChannels(false).catch(function () {
        return { channels: maxLinkedChatsCache };
      }),
      fetchTelegramLinkedChats(false).catch(function () {
        return { channels: tgLinkedChatsCache };
      }),
    ])
      .then(function (bundle) {
        if (currentRoute !== 'tgchains') return;
        var data = bundle[0];
        var maxChannels = bundle[1].channels || maxLinkedChatsCache || [];
        var tgChats = bundle[2].channels || tgLinkedChatsCache || [];
        var chains = data.chains || [];
        var st = data.stats || {};
        var tgInt = integrationsCache.find(function (i) {
          return i.platform === 'telegram' && i.status === 'connected';
        });

        var html = '<div class="tg-chains-page">';
        html += '<h2 style="margin:0 0 8px">Пересылка Telegram → MAX</h2>';

        html += '<section class="card-like tg-chain-hero">';
        html += '<div class="tg-chain-flow-diagram">';
        html += '<div class="tg-chain-node tg-source"><div class="tg-chain-node-badge">TG</div>';
        html += '<div class="tg-chain-node-title">Telegram</div><div class="tg-chain-node-sub">откуда берём посты</div></div>';
        html += '<div class="tg-chain-arrow">→</div>';
        html += '<div class="tg-chain-node max-dest"><div class="tg-chain-node-badge">MAX</div>';
        html += '<div class="tg-chain-node-title">MAX</div><div class="tg-chain-node-sub">куда публикуем</div></div>';
        html += '</div>';
        html +=
          '<p class="muted text-sm" style="margin:12px 0 10px;line-height:1.5">Опубликовали в Telegram — бот перехватывает пост и сразу публикует в MAX (текст, фото, видео, файлы).</p>';
        html += '<ol class="tg-chain-steps">';
        html += '<li>Бот Telegram — администратор в <strong>исходном</strong> канале</li>';
        html += '<li>Бот MAX — администратор в <strong>целевом</strong> канале</li>';
        html += '<li>У TG-бота нет webhook (иначе перехват не работает)</li>';
        html += '</ol></section>';

        html += '<section class="card-like forwarding-section">';
        html += '<h3 class="tg-chain-setup-title">Настроить пересылку</h3>';
        html += '<p class="muted text-sm" style="margin:0 0 14px">Шаг 1 — канал-источник, шаг 2 — канал в MAX. Списки из «Интеграции».</p>';
        html += '<div class="forwarding-add-form forwarding-add-form--picks">';
        html +=
          '<div class="form-group" id="tc_tg_wrap"><div class="flex-between" style="align-items:center;gap:8px;margin-bottom:6px"><label style="margin:0">① Telegram — откуда</label><button type="button" class="btn btn-ghost btn-sm" id="tc_refresh_tg"><i data-lucide="refresh-cw"></i> Обновить</button></div>';
        html += buildTelegramChannelSelect('tc_tg_select', tgChats, 'tc_tg_manual', { adminOnly: true }) + '</div>';
        html +=
          '<div class="form-group"><div class="flex-between" style="align-items:center;gap:8px;margin-bottom:6px"><label style="margin:0">② MAX — куда</label><button type="button" class="btn btn-ghost btn-sm" id="tc_refresh_max"><i data-lucide="refresh-cw"></i> Обновить</button></div>';
        html += '<select class="select" id="tc_max">' + buildMaxChannelSelectOptions(maxChannels, { adminOnly: true }) + '</select></div>';
        html += '<div id="tc_pair_preview" class="tg-chain-pair-live is-empty"></div>';
        html += '<div id="tcToggles">';
        html += toggleRow('forward_posts', 'Пересылать посты', 'Новые публикации в TG → MAX', true);
        html += toggleRow('add_comments_button', 'Кнопка «Комментарии» в MAX', '', true);
        html += '</div>';
        html += '<details class="tg-chain-advanced"><summary>Дополнительно</summary><div style="margin-top:10px">';
        html += toggleRow('add_signature', 'Подпись «— TG»', '', false);
        html += toggleRow('forward_comments', 'Пересылать комментарии TG', 'Опционально', false);
        html += '</div></details>';
        if (!tgInt) {
          html +=
            '<div class="form-group mt-sm"><label>Токен бота Telegram</label><input class="input mono" id="tc_token" type="password" placeholder="Или подключите в «Интеграции»"/></div>';
        }
        html += '<div class="forwarding-add-form-actions" style="margin-top:14px">';
        html += '<button type="button" class="btn btn-primary" id="tc_submit"><i data-lucide="zap"></i> Включить пересылку</button>';
        html += '</div></div></section>';

        html += '<div class="stats-grid" style="margin:16px 0">';
        html += '<div class="stat-card"><div class="label">Активных</div><div class="value">' + esc(fmtNum(st.active)) + '</div></div>';
        html += '<div class="stat-card"><div class="label">Сегодня переслано</div><div class="value">' + esc(fmtNum(st.forwarded_today)) + '</div></div>';
        html += '<div class="stat-card"><div class="label">Ошибки</div><div class="value">' + esc(fmtNum(st.errors_today)) + '</div></div>';
        html += '</div>';

        html += '<h3 class="tg-chain-list-title">Настроенные пары</h3>';
        if (chains.length) {
          chains.forEach(function (c) {
            html += renderTgChainCardHtml(c);
          });
        } else {
          html +=
            '<div class="tg-chain-empty"><p style="margin:0 0 6px">Пока нет цепочек</p><p class="text-sm muted" style="margin:0">Выберите каналы выше и нажмите «Включить пересылку»</p></div>';
        }
        html += '</div>';
        main.innerHTML = html;
        qsa('.tg-chain-card', main).forEach(function (card) {
          bindTgChainCard(card, card.getAttribute('data-chain-id'));
        });
        bindTgChainSetupPage(main);
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
    html += '<div><h2 class="forwarding-section-title" style="margin:0">MTProto — архив канала</h2>';
    html +=
      '<p class="muted text-sm" style="margin:6px 0 0;line-height:1.45">Для переноса ~30 и более старых постов нужен <strong>user-аккаунт</strong> Telegram. Ключи — на <a href="https://my.telegram.org/apps" target="_blank" rel="noopener">my.telegram.org</a>. Аккаунт должен видеть канал (участник или админ).</p></div>';
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
    main.innerHTML = '<div class="dash-loading muted">Загрузка каналов…</div>';

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
    var main = qs('#mainContent');
    if (!main) return;
    main.innerHTML = '<div class="dash-loading muted">Загрузка…</div>';
    Promise.all([
      getJson('/autoposts'),
      getJson('/autoposts/channels').catch(function () {
        return { channels: [], hint: 'Не удалось загрузить каналы Telegram' };
      }),
    ])
      .then(function (pair) {
        if (currentRoute !== 'autoposts') return;
        var posts = pair[0].posts || [];
        var chData = pair[1];
        var chans = chData.channels || [];
        var hint = chData.hint;
        var sel = chans
          .map(function (c) {
            var label = c.title || c.id;
            if (c.username) label += ' (@' + c.username + ')';
            return '<option value="' + esc(String(c.id)) + '">' + esc(label) + '</option>';
          })
          .join('');
        if (!sel) {
          sel = '<option value="">— нет каналов —</option>';
        }
        var weekdayLabels = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
        var wdChecks = '';
        for (var d = 0; d <= 6; d++) {
          wdChecks +=
            '<label class="inline-flex gap-xs" style="margin-right:0.5rem"><input type="checkbox" class="ap_wd" value="' +
            d +
            '"' +
            (d >= 1 && d <= 5 ? ' checked' : '') +
            '/> ' +
            weekdayLabels[d] +
            '</label>';
        }
        var html = '<h2>Автопосты</h2>';
        html +=
          '<p class="muted text-sm mb-md">Отложенная публикация в Telegram-каналы из раздела «Интеграции». Альбомы не поддерживают инлайн-кнопку — используйте одно фото/видео или кнопку без альбома.</p>';
        if (hint) {
          html += '<p class="text-sm" style="color:var(--warning,#e6a700)">' + esc(hint) + '</p>';
        }
        html +=
          '<div class="card-like mb-md" style="background:var(--bg-surface);border:1px solid var(--border-subtle);border-radius:var(--radius-md);padding:1rem">';
        html += '<h3 style="margin-top:0">Создать автопост</h3>';
        html += '<div class="form-row">';
        html +=
          '<div class="form-group"><label>Канал Telegram</label><select class="select" id="ap_chat">' +
          sel +
          '</select></div>';
        html +=
          '<div class="form-group"><label>Тип расписания</label><select class="select" id="ap_schedule_type">';
        html += '<option value="once">Единоразово</option><option value="recurring">По дням недели</option>';
        html += '</select></div>';
        html += '</div>';
        html += '<div id="ap_once_block" class="form-group"><label>Дата и время</label>';
        html += '<input type="datetime-local" class="input" id="ap_when_once"/></div>';
        html += '<div id="ap_recur_block" class="form-group" style="display:none">';
        html += '<label>Время (каждый выбранный день)</label><input type="time" class="input" id="ap_time_recur" value="08:00"/>';
        html += '<div class="mt-sm"><label>Дни недели</label><div>' + wdChecks + '</div></div></div>';
        html += '<div class="form-group"><label>Текст поста</label><textarea class="textarea" id="ap_text" rows="4"></textarea></div>';
        html +=
          '<div class="form-group"><label>Медиа (фото/видео, до 10)</label><input type="file" class="input" id="ap_media" multiple accept="image/*,video/*"/></div>';
        html += '<div class="form-row">';
        html +=
          '<div class="form-group"><label>Кнопка — текст</label><input class="input" id="ap_btn_text" placeholder="Открыть сайт"/></div>';
        html +=
          '<div class="form-group"><label>Кнопка — URL</label><input class="input" id="ap_btn_url" placeholder="https://"/></div>';
        html += '</div>';
        html += '<button type="button" class="btn btn-primary" id="ap_create">Запланировать</button></div>';
        html += '<div class="table-wrap"><table><thead><tr>';
        html +=
          '<th>Канал</th><th>Текст</th><th>След. запуск</th><th>Расписание</th><th>Статус</th><th></th>';
        html += '</tr></thead><tbody>';
        posts.forEach(function (p) {
          var sched =
            p.schedule_type === 'recurring'
              ? (p.recurring_time || '—') + ' · дни ' + (p.weekdays ? p.weekdays.join(',') : '—')
              : 'единоразово';
          html += '<tr>';
          html += '<td>' + esc(p.channel_title || p.target_channel_id) + '</td>';
          html +=
            '<td style="max-width:200px;overflow:hidden;text-overflow:ellipsis" title="' +
            esc(p.text) +
            '">' +
            esc(p.text || '—') +
            (p.media && p.media.length ? ' 📎' + p.media.length : '') +
            '</td>';
          html += '<td class="mono text-sm">' + esc(p.scheduled_at) + '</td>';
          html += '<td class="text-sm">' + esc(sched) + '</td>';
          html += '<td>' + esc(apStatusLabel(p.status)) + '</td>';
          html += '<td class="flex gap-xs" style="flex-wrap:wrap">';
          if (p.status === 'active') {
            html +=
              '<button type="button" class="btn btn-ghost btn-sm" data-pause-ap="' +
              esc(p.id) +
              '">Пауза</button>';
          }
          if (p.status === 'paused' || p.status === 'failed') {
            html +=
              '<button type="button" class="btn btn-ghost btn-sm" data-resume-ap="' +
              esc(p.id) +
              '">Возобновить</button>';
          }
          html +=
            '<button type="button" class="btn btn-danger btn-sm" data-del-ap="' +
            esc(p.id) +
            '">Удалить</button></td>';
          html += '</tr>';
        });
        if (!posts.length) html += '<tr><td colspan="6" class="muted">Нет запланированных постов</td></tr>';
        html += '</tbody></table></div>';
        main.innerHTML = html;

        var scheduleTypeEl = qs('#ap_schedule_type', main);
        var onceBlock = qs('#ap_once_block', main);
        var recurBlock = qs('#ap_recur_block', main);
        scheduleTypeEl.addEventListener('change', function () {
          var recurring = scheduleTypeEl.value === 'recurring';
          onceBlock.style.display = recurring ? 'none' : '';
          recurBlock.style.display = recurring ? '' : 'none';
        });

        qs('#ap_create', main).addEventListener('click', function () {
          var channelId = (qs('#ap_chat', main).value || '').trim();
          var text = (qs('#ap_text', main).value || '').trim();
          var scheduleType = scheduleTypeEl.value;
          var btnText = (qs('#ap_btn_text', main).value || '').trim();
          var btnUrl = (qs('#ap_btn_url', main).value || '').trim();
          var mediaInput = qs('#ap_media', main);
          var files = mediaInput && mediaInput.files ? mediaInput.files : [];
          if (!channelId) {
            showToast('Выберите канал Telegram', 'error');
            return;
          }
          if (!text && (!files || !files.length)) {
            showToast('Укажите текст или прикрепите медиа', 'error');
            return;
          }
          if (files.length > 1 && btnText && btnUrl) {
            showToast('Инлайн-кнопка недоступна для альбома', 'error');
            return;
          }
          var fd = new FormData();
          fd.append('target_channel_id', channelId);
          var chOpt = qs('#ap_chat', main).selectedOptions[0];
          if (chOpt) fd.append('channel_title', chOpt.textContent || '');
          fd.append('text', text);
          fd.append('schedule_type', scheduleType);
          if (scheduleType === 'once') {
            var whenLocal = (qs('#ap_when_once', main).value || '').trim();
            if (!whenLocal) {
              showToast('Укажите дату и время', 'error');
              return;
            }
            fd.append('scheduled_at', new Date(whenLocal).toISOString());
          } else {
            var timeRecur = (qs('#ap_time_recur', main).value || '08:00').trim();
            var weekdays = [];
            qsa('.ap_wd:checked', main).forEach(function (cb) {
              weekdays.push(Number(cb.value));
            });
            if (!weekdays.length) {
              showToast('Выберите хотя бы один день недели', 'error');
              return;
            }
            fd.append('recurring_time', timeRecur);
            fd.append('weekdays', JSON.stringify(weekdays));
            var probe = new Date();
            var parts = timeRecur.split(':');
            probe.setHours(Number(parts[0]), Number(parts[1]), 0, 0);
            fd.append('scheduled_at', probe.toISOString());
          }
          if (btnText && btnUrl) {
            fd.append('inline_button_text', btnText);
            fd.append('inline_button_url', btnUrl);
          }
          for (var i = 0; i < files.length; i++) {
            fd.append('media', files[i]);
          }
          postForm('/autoposts', fd)
            .then(function () {
              showToast('Автопост запланирован', 'success');
              renderAutoposts();
            })
            .catch(function (e) {
              showToast(e.message || 'Ошибка', 'error');
            });
        });

        qsa('[data-del-ap]', main).forEach(function (b) {
          b.addEventListener('click', function () {
            deleteReq('/autoposts/' + encodeURIComponent(b.getAttribute('data-del-ap')))
              .then(function () {
                showToast('Удалено', 'success');
                renderAutoposts();
              })
              .catch(function (e) {
                showToast(e.message || 'Ошибка', 'error');
              });
          });
        });
        qsa('[data-pause-ap]', main).forEach(function (b) {
          b.addEventListener('click', function () {
            patchJson('/autoposts/' + encodeURIComponent(b.getAttribute('data-pause-ap')) + '/pause', {})
              .then(function () {
                showToast('На паузе', 'success');
                renderAutoposts();
              })
              .catch(function (e) {
                showToast(e.message || 'Ошибка', 'error');
              });
          });
        });
        qsa('[data-resume-ap]', main).forEach(function (b) {
          b.addEventListener('click', function () {
            patchJson('/autoposts/' + encodeURIComponent(b.getAttribute('data-resume-ap')) + '/resume', {})
              .then(function () {
                showToast('Возобновлено', 'success');
                renderAutoposts();
              })
              .catch(function (e) {
                showToast(e.message || 'Ошибка', 'error');
              });
          });
        });
        refreshIcons();
      })
      .catch(function (err) {
        if (err && err.message === 'auth') return;
        main.innerHTML = '<p class="muted">Ошибка загрузки</p>';
      });
  }

  function bindIntTabs(main) {
    qsa('[data-int-tab]', main).forEach(function (btn) {
      btn.addEventListener('click', function () {
        integrationsTab = btn.getAttribute('data-int-tab') || 'connections';
        renderIntegrations();
      });
    });
  }

  function renderIntegrations() {
    var main = qs('#mainContent');
    if (!main) return;
    main.innerHTML = '<div class="dash-loading muted">Загрузка…</div>';
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

        var html = '<div class="int-page"><div class="int-tabs">';
        ['connections', 'flows', 'analytics'].forEach(function (tab) {
          var labels = { connections: 'Подключения', flows: 'Потоки данных', analytics: 'Аналитика' };
          html +=
            '<button type="button" class="int-tab' +
            (integrationsTab === tab ? ' active' : '') +
            '" data-int-tab="' +
            tab +
            '">' +
            esc(labels[tab]) +
            '</button>';
        });
        html += '</div>';

        if (integrationsTab === 'connections') {
          html += '<div class="integrations-grid">';
          html += integrationCardHtml('telegram', 'Telegram Bot', 'Получение постов из каналов, отправка в MAX', tg, 'tg');
          html += integrationCardHtml('vk', 'ВКонтакте', 'Сообщества: посты, комментарии, аналитика', vk, 'vk');
          maxLinkedChatsCache =
            intMaxMeta && intMaxMeta.channels && intMaxMeta.channels.length
              ? intMaxMeta.channels
              : maxLinkedChatsCache;
          html += maxIntegrationCardHtml(intMaxMeta);
          html += '</div>';
        } else if (integrationsTab === 'flows') {
          html += '<div class="flows-list">';
          flowsCache.forEach(function (f) { html += flowCardHtml(f); });
          if (!flowsCache.length) html += '<p class="muted">Потоков пока нет.</p>';
          html += '</div><button type="button" class="btn btn-primary mt-md" id="btnOpenFlowBuilder"><i data-lucide="plus"></i> Новый поток</button>';
          html += '<div class="flow-builder hidden" id="flow-builder"></div>';
        } else {
          html += '<div class="analytics-grid">';
          html += analyticsCardHtml('telegram', analytics.telegram);
          html += analyticsCardHtml('vk', analytics.vk);
          html += '</div><div class="card-like mt-md"><div class="card-header flex-between"><span>Последние переданные посты</span>';
          html += '<select class="select" id="flow-filter-select"><option value="">Все потоки</option>';
          flowsCache.forEach(function (f) { html += '<option value="' + esc(f.id) + '">' + esc(f.name) + '</option>'; });
          html += '</select></div>';
          html = html.replace('', '');
          html = html.replace('', '<div class="forwarded-list">');
          logItems.forEach(function (item) { html += forwardedItemHtml(item); });
          if (!logItems.length) html += '<p class="muted" style="padding:12px">Пока нет пересланных постов</p>';
          html += '</div></div>';
        }
        html += '</div>';
        main.innerHTML = html;
        bindIntTabs(main);
        bindIntegrationsPage(main);
        var tgRec = integrationsCache.find(function (i) { return i.platform === 'telegram' && i.status === 'connected'; });
        if (tgRec) {
          tgLinkedChatsCache = tgRec.linkedChats || tgLinkedChatsCache;
          var panel = qs('[data-tg-chats-panel="' + tgRec.id + '"]', main);
          if (panel) {
            mountTelegramChatsPanel(panel, tgRec.id, tgLinkedChatsCache);
            bindTelegramChatsPanel(panel);
            if (!tgLinkedChatsCache.length) {
              fetchTelegramLinkedChats(true)
                .then(function (data) {
                  mountTelegramChatsPanel(panel, tgRec.id, data.channels || []);
                  bindTelegramChatsPanel(panel);
                  refreshIcons();
                })
                .catch(function () {});
            }
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
                metaEl.innerHTML =
                  '<span>Каналов: <strong>' +
                  esc(String(data.channels.length)) +
                  '</strong> (админ: <strong>' +
                  esc(String(admins)) +
                  '</strong>)</span><span>Bot Token: <code>••••••••' +
                  esc((intMaxMeta && intMaxMeta.tokenPreview) || '') +
                  '</code></span>';
              }
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
    var savedToken = record && record.token ? String(record.token) : '';
    var hasToken = integrationHasToken(record);
    var logo = platform === 'vk' ? 'VK' : 'TG';
    var html =
      '<div class="integration-card' +
      (connected ? ' connected' : '') +
      '"><div class="int-card-header"><div class="int-logo ' +
      platform +
      '">' +
      logo +
      '</div><div class="int-info"><div class="int-name">' +
      esc(title) +
      '</div><div class="int-desc">' +
      esc(desc) +
      '</div></div><span class="int-status ' +
      (connected ? 'connected' : 'disconnected') +
      '">' +
      (connected ? '<i data-lucide="circle-check"></i> Подключён' : 'Не подключён') +
      '</span></div>';
    if (connected && record && !integrationHasToken(record)) {
      html +=
        '<div class="int-token-warning muted text-sm">Токен не задан — откройте «Настроить» и вставьте токен от @BotFather</div>';
    }
    if (connected && record) {
      html += savedTokenBlockHtml(prefix, record);
    }
    if (platform === 'telegram' && connected && record) {
      var adminCount = (record.linkedChats || []).filter(function (c) {
        return c.botIsAdmin === true;
      }).length;
      html +=
        '<div class="int-meta"><span>Бот: <strong>' +
        esc(record.name || 'Telegram') +
        '</strong></span>' +
        (record.linkedChats && record.linkedChats.length
          ? '<span> · чатов: <strong>' +
            esc(String(record.linkedChats.length)) +
            '</strong> (админ: <strong>' +
            esc(String(adminCount)) +
            '</strong>)</span>'
          : '') +
        '</div>';
      html +=
        '<div class="tg-chats-panel-wrap" data-tg-chats-panel="' +
        esc(record.id) +
        '"></div>';
    }
    html +=
      '<div class="int-body hidden" id="' +
      prefix +
      '-form"><div class="form-group"><label>' +
      (platform === 'vk' ? 'Access Token' : 'Bot Token') +
      '</label><input class="input mono" type="password" id="' +
      prefix +
      '-token" value="' +
      esc(savedToken) +
      '" placeholder="' +
      (hasToken ? 'Пусто = не менять токен · ' : '') +
      'Токен от @BotFather" autocomplete="off"/></div>';

    if (platform === 'vk') {
      html +=
        '<div class="form-group"><label>ID сообщества</label><input class="input" id="vk-group" value="' +
        esc((record && record.groupId) || '') +
        '"/></div>';
    } else {
      html +=
        '<div class="form-group"><label>Имя бота</label><input class="input" id="tg-name" value="' +
        esc((record && record.name) || '') +
        '"/></div>';
    }
    html +=
      '<div class="int-actions"><button type="button" class="btn btn-primary" data-connect="' +
      platform +
      '"><i data-lucide="plug"></i> Подключить</button>';
    if (record) {
      html +=
        '<button type="button" class="btn btn-ghost" data-test-int="' +
        esc(record.id) +
        '"><i data-lucide="activity"></i> Проверить</button>';
    }
    html +=
      '</div></div><button type="button" class="int-expand-btn" data-expand="' +
      prefix +
      '-form">Настроить <i data-lucide="chevron-down"></i></button></div>';
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
    var html = '<div class="flow-card" data-flow-id="' + esc(f.id) + '"><div class="flow-pipeline">';
    html += flowNodeHtml(f.source.platform, srcName);
    html += '<div class="flow-arrow"><i data-lucide="arrow-right"></i>';
    if (filterCount) html += '<span class="flow-filter-badge"><i data-lucide="filter"></i> ' + filterCount + '</span>';
    html += '</div>' + flowNodeHtml(f.destination.platform, destName);
    html +=
      '</div><div class="flow-meta"><span class="flow-stat">Переслано: <strong>' +
      esc(String(f.stats.totalForwarded || 0)) +
      '</strong></span><span class="flow-stat">Последний: <strong>' +
      esc(fmtRelativeTime(f.stats.lastForwardedAt)) +
      '</strong></span></div><div class="flow-actions"><span class="switch' +
      (f.enabled ? ' on' : '') +
      '" data-flow-toggle="' +
      esc(f.id) +
      '" role="switch" tabindex="0"></span><button type="button" class="btn btn-ghost btn-sm" data-test-flow="' +
      esc(f.id) +
      '"><i data-lucide="activity"></i> Проверить</button><button type="button" class="btn btn-ghost btn-sm" data-del-flow="' +
      esc(f.id) +
      '"><i data-lucide="trash-2"></i></button></div></div>';
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
    qsa('[data-expand]', main).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var body = qs('#' + btn.getAttribute('data-expand'), main);
        if (body) body.classList.toggle('hidden');
      });
    });
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
    var tgBots = integrationsCache.filter(function (i) { return i.platform === 'telegram' && i.status === 'connected'; });
    var vkGroups = integrationsCache.filter(function (i) { return i.platform === 'vk' && i.status === 'connected'; });
    var maxChannels = (intMaxMeta && intMaxMeta.channels) || [];
    host.innerHTML =
      '<h3>Создать поток</h3><div class="form-group"><label>Платформа</label><select class="select" id="fb_src_platform"><option value="telegram">Telegram</option><option value="vk">VK</option></select></div>' +
      '<div class="form-group"><label>Интеграция</label><select class="select" id="fb_src_int">' +
      tgBots.map(function (b) { return '<option value="' + esc(b.id) + '">' + esc(b.name) + '</option>'; }).join('') +
      '</select></div><div id="fb_src_channel_wrap"><div class="form-group"><label>Канал</label><input class="input" id="fb_src_channel" placeholder="@channel"/></div></div>' +
      '<div class="form-group"><label>Слова</label><input class="input" id="fb_kw"/></div><div class="form-group"><label>Исключить</label><input class="input" id="fb_ex"/></div>' +
      '<label class="checkbox-label"><input type="checkbox" id="fb_media"/> Только медиа</label>' +
      '<div class="form-group"><label>MAX-канал</label><select class="select" id="fb_dest_channel">' +
      maxChannels.map(function (c) { return '<option value="' + esc(c.id) + '">' + esc(c.title) + '</option>'; }).join('') +
      '</select></div><div class="form-group"><label>Подпись</label><input class="input" id="fb_signature"/></div>' +
      '<div class="builder-actions"><button type="button" class="btn btn-primary" id="fb_save">Создать</button><button type="button" class="btn btn-ghost" id="fb_cancel">Отмена</button></div>';
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
    qs('#fb_cancel', host).addEventListener('click', function () { host.classList.add('hidden'); host.innerHTML = ''; });
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
        host.classList.add('hidden');
        integrationsTab = 'flows';
        renderIntegrations();
      }).catch(function (e) { showToast(e.message || 'Ошибка', 'error'); });
    });
    refreshIcons();
  }
  function renderAntispam() {
    var main = qs('#mainContent');
    if (!main) return;
    main.innerHTML = '<div class="dash-loading muted">Загрузка…</div>';
    Promise.all([getJson('/antispam/words'), getJson('/antispam/log?limit=100')])
      .then(function (pair) {
        if (currentRoute !== 'antispam') return;
        var w = pair[0];
        var log = pair[1].entries || [];
        var rules = w.rules || {};
        var html = '<h2>Глобальный антиспам</h2>';
        html += '<p class="text-sm muted">Заблокировано сегодня: <strong>' + esc(String(w.blocked_today || 0)) + '</strong></p>';
        html += '<div class="form-group"><label>Глобальные стоп-слова</label><div class="tags-input-wrap" id="g_stop"></div></div>';
        html += '<div id="gRules">';
        html += toggleRow('block_links', 'Блокировать ссылки', 'Глобально', !!rules.block_links);
        html += toggleRow('flood_protection', 'Антифлуд', '', !!rules.flood_protection);
        html += toggleRow('caps_protection', 'КАПС', '', !!rules.caps_protection);
        html += toggleRow('emoji_spam', 'Спам эмодзи', '', !!rules.emoji_spam);
        html += '</div>';
        html += '<button type="button" class="btn btn-primary mt-sm" id="btnSaveGlobalAs">Сохранить слова и правила</button>';
        html += '<h3 class="mt-md">Журнал блокировок</h3>';
        html += '<div class="table-wrap"><table><thead><tr>';
        html += '<th>Время</th><th>Канал</th><th>Пользователь</th><th>Причина</th><th>Текст</th>';
        html += '</tr></thead><tbody>';
        log.forEach(function (e) {
          html += '<tr>';
          html += '<td class="mono text-sm">' + esc(e.created_at) + '</td>';
          html += '<td>' + esc(e.channel_title || String(e.channel_chat_id)) + '</td>';
          html += '<td>' + esc(e.username || String(e.user_id)) + '</td>';
          html += '<td>' + esc(e.reason) + '</td>';
          html += '<td style="max-width:200px">' + esc(e.text) + '</td>';
          html += '</tr>';
        });
        if (!log.length) html += '<tr><td colspan="5" class="muted">Пусто</td></tr>';
        html += '</tbody></table></div>';
        main.innerHTML = html;
        var wrap = qs('#g_stop', main);
        if (wrap) bindTagsInput(wrap, w.global || [], function () {});
        bindToggleRows(main, null);
        qs('#btnSaveGlobalAs', main).addEventListener('click', function () {
          var tags = [];
          qsa('.tag', wrap).forEach(function (tg) {
            var txt = tg.firstChild;
            if (txt && txt.nodeType === 3) tags.push(String(txt.textContent || '').trim());
          });
          var sw = readSwitches(main);
          postJson('/antispam/words', {
            global: tags,
            rules: {
              block_links: !!sw.block_links,
              flood_protection: !!sw.flood_protection,
              caps_protection: !!sw.caps_protection,
              emoji_spam: !!sw.emoji_spam,
            },
          })
            .then(function () {
              showToast('Сохранено', 'success');
              renderAntispam();
            })
            .catch(function (e) {
              showToast(e.message || 'Ошибка', 'error');
            });
        });
        refreshIcons();
      })
      .catch(function (err) {
        if (err && err.message === 'auth') return;
        main.innerHTML = '<p class="muted">Ошибка</p>';
      });
  }

  function renderComments() {
    var main = qs('#mainContent');
    if (!main) return;
    getJson('/channels')
      .then(function (data) {
        if (currentRoute !== 'comments') return;
        channelsCache = data.channels || [];
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
        main.innerHTML =
          '<div class="search-bar">' +
          '<select class="select" id="com_chat" style="max-width:280px">' +
          sel +
          '</select>' +
          '<input class="input" id="com_q" placeholder="Поиск" value="' +
          esc(commentsQuery) +
          '"/>' +
          '<button type="button" class="btn btn-primary" id="com_load">Показать</button></div>' +
          '<div id="com_list" class="muted">Нажмите «Показать»</div>';
        qs('#com_load', main).addEventListener('click', function () {
          commentsChatId = Number(qs('#com_chat', main).value);
          commentsQuery = (qs('#com_q', main).value || '').trim();
          loadCommentsList();
        });
        refreshIcons();
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
    getJson('/comments?chat_id=' + encodeURIComponent(String(commentsChatId)) + q)
      .then(function (data) {
        var list = data.comments || [];
        var html = '<div class="table-wrap"><table><thead><tr>';
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
        if (!list.length) html += '<tr><td colspan="5" class="muted">Нет комментариев</td></tr>';
        html += '</tbody></table></div>';
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
      return '<div class="empty-state"><i data-lucide="users"></i><h3>Пользователи не найдены</h3><p>Измените фильтр или дождитесь новых подписчиков.</p></div>';
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
    main.innerHTML = '<div class="dash-loading muted">Загрузка пользователей…</div>';
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
    main.innerHTML = '<div class="dash-loading muted">Загрузка…</div>';
    getJson('/settings')
      .then(function (s) {
        if (currentRoute !== 'settings') return;
        var sec = s.poll_interval_sec != null ? s.poll_interval_sec : 30;
        var html = '<h2>Настройки</h2>';
        html += '<div class="form-group"><label>Интервал опроса (сек)</label>';
        html +=
          '<input class="input mono" id="set_poll" type="number" step="1" min="1" value="' +
          esc(String(sec)) +
          '"/></div>';
        html += '<button type="button" class="btn btn-primary" id="set_save_poll">Сохранить интервал</button>';
        html += '<h3 class="mt-md">Сброс данных</h3><p class="text-sm muted">Опасные операции — только при необходимости.</p>';
        html += '<div class="flex gap-sm mt-sm">';
        html += '<button type="button" class="btn btn-danger" id="set_reset_posts">Сбросить посты и комментарии</button>';
        html += '<button type="button" class="btn btn-danger" id="set_reset_subs">Сбросить подписчиков</button>';
        html += '</div>';
        html += '<p class="text-sm mt-md muted">Бот: ' + esc(s.bot_nickname || '') + '</p>';
        main.innerHTML = html;
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
      })
      .catch(function () {
        main.innerHTML = '<p class="muted">Ошибка загрузки</p>';
      });
  }

  function renderTopbarForRoute() {
    if (currentRoute === 'dashboard' || currentRoute === 'dashboard_tg') {
      var periodValue = currentRoute === 'dashboard_tg' ? tgDashPeriodDays : dashPeriodDays;
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
            } else if (currentRoute === 'dashboard_tg') {
              tgDashPeriodDays = picked;
              renderTopbarForRoute();
              renderTelegramDashboard(true);
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
    if (location.hash.replace(/^#/, '') !== currentRoute) {
      location.hash = currentRoute;
    }
    setPageTitle();
    renderSidebar();
    renderTopbarForRoute();
    if (currentRoute === 'dashboard') {
      scheduleDashRefresh();
      renderDashboard(true);
    } else if (currentRoute === 'dashboard_tg') {
      scheduleDashRefresh();
      renderTelegramDashboard(true);
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
        var labelEl = null;
        var ch = el.children;
        for (var i = 0; i < ch.length; i++) {
          if (ch[i] !== dot && ch[i].tagName === 'SPAN') labelEl = ch[i];
        }
        if (s.active) {
          if (labelEl) labelEl.textContent = s.label || 'Бот активен';
          if (dot) dot.style.background = 'var(--success)';
        } else {
          if (labelEl) labelEl.textContent = s.label || 'Неактивен';
          if (dot) dot.style.background = 'var(--danger)';
        }
      })
      .catch(function () {
        /* ignore */
      });
  }

  function boot() {
    getJson('/stats')
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
      })
      .catch(function () {
        /* handleAuth redirects */
      });
  }

  boot();
})();
