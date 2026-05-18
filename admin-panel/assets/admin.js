(function () {
  'use strict';

  var API_BASE = '/api/admin';
  var API_INTEGRATIONS = '/api/integrations';
  var API_FLOWS = '/api/flows';
  var API_INT_ANALYTICS = '/api/integrations-analytics';
  var integrationsTab = 'connections';
  var integrationsCache = [];
  var flowsCache = [];
  var intMaxMeta = null;
  var currentRoute = '';
  var dashRefreshTimer = null;
  var dashPeriodDays = 7;
  var channelsCache = [];
  var selectedChannelId = null;
  var channelDetailTab = 'stats';
  var commentsChatId = null;
  var commentsQuery = '';
  var usersCache = [];

  var NAV = [
    { group: 'Обзор', items: [{ id: 'dashboard', label: 'Дашборд', icon: 'layout-dashboard' }] },
    {
      group: 'Контент',
      items: [
        { id: 'channels', label: 'Каналы', icon: 'radio' },
        { id: 'tgchains', label: 'TG-цепочки', icon: 'link-2' },
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
    dashboard: 'Дашборд',
    channels: 'Каналы',
    tgchains: 'TG-цепочки',
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
    if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    return fetch(url, opts).then(handleAuth);
  }

  function getJson(path) {
    return authFetch(apiPath(path)).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function postJson(path, body) {
    return authFetch(apiPath(path), { method: 'POST', body: body || {} }).then(function (r) {
      if (!r.ok) {
        return r.json().then(function (j) {
          throw new Error(j.error || 'Ошибка');
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

  function scheduleDashRefresh() {
    clearDashTimer();
    dashRefreshTimer = window.setInterval(function () {
      if (currentRoute === 'dashboard') {
        renderDashboard(false);
      }
    }, 30000);
  }

  function parseHashRoute() {
    var raw = (location.hash || '').replace(/^#/, '').trim();
    if (raw === '') return 'dashboard';
    var id = raw.split(/[/?]/)[0];
    var allowed = {
      dashboard: 1,
      channels: 1,
      tgchains: 1,
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
              '<button type="button" class="list-item' +
              (active ? ' active' : '') +
              '" data-cid="' +
              esc(String(c.chat_id)) +
              '">';
            html += '<div class="list-item-title">' + esc(c.title || 'Канал ' + c.chat_id) + '</div>';
            html +=
              '<div class="list-item-sub">' +
              esc(c.status === 'pending' ? 'Ожидает прав' : 'Активен') +
              ' · ' +
              esc(fmtNum(c.comment_count)) +
              ' коммент.</div></button>';
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
        var html = '<div class="flex-between mb-md">';
        html += '<h2 style="margin:0">' + esc(ch.title || 'Канал ' + chatId) + '</h2>';
        html += '<div class="flex gap-sm">';
        html +=
          '<button type="button" class="btn btn-ghost btn-sm" id="btnRefreshBtns">Обновить кнопки</button>';
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
          html += '<h3>Последние комментарии</h3><ul class="insights-list">';
          (detail.recent_comments || []).forEach(function (c) {
            html +=
              '<li><strong>' +
              esc(c.username) +
              '</strong> — ' +
              esc(c.text) +
              ' <span class="muted text-sm">(' +
              esc(c.timestamp || '') +
              ')</span></li>';
          });
          if (!(detail.recent_comments || []).length) {
            html += '<li class="muted">Нет данных</li>';
          }
          html += '</ul>';
        } else if (channelDetailTab === 'settings') {
          html += '<div id="chSettingsForm">';
          html += '<div class="form-group"><label>Текст кнопки</label>';
          html +=
            '<input class="input" id="f_btn_text" value="' +
            esc(settings.button_text || '') +
            '"/></div>';
          html += '<div class="form-group"><label>Приветствие</label>';
          html +=
            '<textarea class="textarea" id="f_welcome">' +
            esc(settings.welcome_message || '') +
            '</textarea></div>';
          html += '<div id="setToggles">';
          html += toggleRow('notify_admin', 'Уведомлять админа', 'О новых комментариях', !!settings.notify_admin);
          html += toggleRow('show_reactions', 'Показывать реакции', '', !!settings.show_reactions);
          html += toggleRow('moderation_mode', 'Режим модерации', '', !!settings.moderation_mode);
          html += '</div>';
          html +=
            '<button type="button" class="btn btn-primary mt-sm" id="btnSaveChannel">Сохранить</button>';
          html += '</div>';
        } else {
          html += '<div id="chAntispamForm">';
          html += '<div class="form-group"><label>Стоп-слова канала</label>';
          html += '<div class="tags-input-wrap" id="chStopwords"></div></div>';
          html += '<div id="asToggles">';
          html += toggleRow('block_links', 'Блокировать ссылки', '', !!settings.block_links);
          html += toggleRow('flood_protection', 'Защита от флуда', '', !!settings.flood_protection);
          html += toggleRow('auto_mute', 'Авто-мут', '', !!settings.auto_mute);
          html += '</div>';
          html +=
            '<button type="button" class="btn btn-primary mt-sm" id="btnSaveAntispamCh">Сохранить</button>';
          html += '</div>';
        }
        slot.innerHTML = html;
        qsa('#chTabs .tab', slot).forEach(function (t) {
          t.addEventListener('click', function () {
            channelDetailTab = t.getAttribute('data-tab') || 'stats';
            loadChannelDetail(chatId);
          });
        });
        var btnRef = qs('#btnRefreshBtns', slot);
        if (btnRef) {
          btnRef.addEventListener('click', function () {
            postJson('/refresh-buttons', { chat_id: chatId })
              .then(function () {
                showToast('Кнопки обновлены', 'success');
              })
              .catch(function (e) {
                showToast(e.message || 'Ошибка', 'error');
              });
          });
        }
        var btnRm = qs('#btnRemoveChannel', slot);
        if (btnRm) {
          btnRm.addEventListener('click', function () {
            showConfirm(
              'Отключить канал?',
              'Бот перестанет обслуживать этот канал. Продолжить?',
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
        var setRoot = qs('#chSettingsForm', slot);
        if (setRoot) {
          bindToggleRows(setRoot, null);
          var save = qs('#btnSaveChannel', slot);
          if (save) {
            save.addEventListener('click', function () {
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
                  loadChannelDetail(chatId);
                })
                .catch(function (e) {
                  showToast(e.message || 'Ошибка', 'error');
                });
            });
          }
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
              var sw2 = readSwitches(asRoot);
              var tags = [];
              qsa('.tag', wrap).forEach(function (tg) {
                var txt = tg.firstChild;
                if (txt && txt.nodeType === 3) tags.push(String(txt.textContent || '').trim());
              });
              postJson('/antispam/channel/' + encodeURIComponent(String(chatId)), {
                stopwords: tags,
                block_links: !!sw2.block_links,
                flood_protection: !!sw2.flood_protection,
                auto_mute: !!sw2.auto_mute,
              })
                .then(function () {
                  showToast('Сохранено', 'success');
                  loadChannelDetail(chatId);
                })
                .catch(function (e) {
                  showToast(e.message || 'Ошибка', 'error');
                });
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

  function renderTgChains() {
    var main = qs('#mainContent');
    if (!main) return;
    main.innerHTML = '<div class="dash-loading muted">Загрузка…</div>';
    getJson('/tg-chains')
      .then(function (data) {
        if (currentRoute !== 'tgchains') return;
        var chains = data.chains || [];
        var st = data.stats || {};
        var html = '<div class="flex-between mb-md"><h2 style="margin:0">TG-цепочки</h2>';
        html += '<button type="button" class="btn btn-primary" id="btnNewChain">Новая цепочка</button></div>';
        html += '<div class="stats-grid mb-md">';
        html +=
          '<div class="stat-card"><div class="label">Активные</div><div class="value">' +
          esc(fmtNum(st.active)) +
          '</div></div>';
        html +=
          '<div class="stat-card"><div class="label">Переслано сегодня</div><div class="value">' +
          esc(fmtNum(st.forwarded_today)) +
          '</div></div>';
        html +=
          '<div class="stat-card"><div class="label">Ошибки сегодня</div><div class="value">' +
          esc(fmtNum(st.errors_today)) +
          '</div></div>';
        html += '</div>';
        html += '<div class="table-wrap"><table><thead><tr>';
        html +=
          '<th>MAX канал</th><th>TG</th><th>Посты</th><th>Коммент.</th><th>Активна</th><th></th>';
        html += '</tr></thead><tbody>';
        chains.forEach(function (c) {
          html += '<tr data-chain-id="' + esc(c.id) + '">';
          html +=
            '<td>' +
            esc(c.max_title || String(c.max_chat_id)) +
            '<div class="mono text-sm muted">' +
            esc(String(c.max_chat_id)) +
            '</div></td>';
          html += '<td class="mono">@' + esc(c.tg_username) + '</td>';
          html +=
            '<td><span class="switch' +
            (c.forward_posts ? ' on' : '') +
            '" data-chain-field="forward_posts" role="switch" tabindex="0"></span></td>';
          html +=
            '<td><span class="switch' +
            (c.forward_comments ? ' on' : '') +
            '" data-chain-field="forward_comments" role="switch" tabindex="0"></span></td>';
          html +=
            '<td><span class="switch' +
            (c.active ? ' on' : '') +
            '" data-chain-field="active" role="switch" tabindex="0"></span></td>';
          html +=
            '<td><button type="button" class="btn btn-danger btn-sm" data-del-chain="' +
            esc(c.id) +
            '">Удалить</button></td>';
          html += '</tr>';
        });
        if (!chains.length) {
          html += '<tr><td colspan="6" class="muted">Цепочек нет</td></tr>';
        }
        html += '</tbody></table></div>';
        html += '<div id="chainModalHost"></div>';
        main.innerHTML = html;
        qsa('tbody tr[data-chain-id]', main).forEach(function (row) {
          var id = row.getAttribute('data-chain-id');
          qsa('.switch', row).forEach(function (sw) {
            sw.addEventListener('click', function (e) {
              e.stopPropagation();
              var field = sw.getAttribute('data-chain-field');
              var next = !sw.classList.contains('on');
              var patch = {};
              patch[field] = next;
              patchJson('/tg-chains/' + encodeURIComponent(id), patch)
                .then(function () {
                  sw.classList.toggle('on', next);
                  showToast('Обновлено', 'success');
                })
                .catch(function (err) {
                  showToast(err.message || 'Ошибка', 'error');
                });
            });
          });
          var del = qs('[data-del-chain]', row);
          if (del) {
            del.addEventListener('click', function () {
              showConfirm('Удалить цепочку?', 'Действие необратимо для этой записи.', function () {
                deleteReq('/tg-chains/' + encodeURIComponent(id))
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
        });
        var btnNew = qs('#btnNewChain', main);
        if (btnNew) {
          btnNew.addEventListener('click', function () {
            openChainModal();
          });
        }
        refreshIcons();
      })
      .catch(function (err) {
        if (err && err.message === 'auth') return;
        main.innerHTML = '<p class="muted">Ошибка: ' + esc(err.message || '') + '</p>';
      });
  }

  function openChainModal() {
    var host = qs('#chainModalHost');
    if (!host) return;
    var opts = channelsCache.length
      ? channelsCache
          .map(function (c) {
            return (
              '<option value="' +
              esc(String(c.chat_id)) +
              '">' +
              esc(c.title || String(c.chat_id)) +
              '</option>'
            );
          })
          .join('')
      : '<option value="">— сначала откройте «Каналы» —</option>';
    host.innerHTML =
      '<div class="modal-backdrop" id="chainBackdrop"><div class="modal"><h2>Новая TG-цепочка</h2>' +
      '<div class="form-group"><label>Канал MAX</label><select class="select" id="m_max_chat">' +
      opts +
      '</select></div>' +
      '<div class="form-group"><label>TG @username</label><input class="input" id="m_tg" placeholder="channel"/></div>' +
      '<div class="form-group"><label>Токен бота TG</label><input class="input mono" id="m_token" type="password" placeholder="token"/></div>' +
      '<div id="mToggles">' +
      toggleRow('forward_posts', 'Пересылать посты', '', true) +
      toggleRow('forward_comments', 'Пересылать комментарии', '', false) +
      toggleRow('add_signature', 'Подпись', '', false) +
      '</div>' +
      '<div class="modal-actions"><button type="button" class="btn btn-ghost" id="m_cancel">Отмена</button>' +
      '<button type="button" class="btn btn-primary" id="m_ok">Создать</button></div></div></div>';
    var backdrop = qs('#chainBackdrop', host);
    bindToggleRows(host, null);
    function close() {
      host.innerHTML = '';
    }
    qs('#m_cancel', host).addEventListener('click', close);
    backdrop.addEventListener('click', function (e) {
      if (e.target === backdrop) close();
    });
    qs('#m_ok', host).addEventListener('click', function () {
      var chatId = Number(qs('#m_max_chat', host).value);
      var tg = (qs('#m_tg', host).value || '').trim().replace(/^@/, '');
      var token = (qs('#m_token', host).value || '').trim();
      var sw = readSwitches(host);
      if (!chatId || !tg) {
        showToast('Укажите канал и username', 'error');
        return;
      }
      postJson('/tg-chains', {
        max_chat_id: chatId,
        tg_username: tg,
        bot_token: token,
        forward_posts: !!sw.forward_posts,
        forward_comments: !!sw.forward_comments,
        add_signature: !!sw.add_signature,
      })
        .then(function () {
          showToast('Цепочка создана', 'success');
          close();
          renderTgChains();
        })
        .catch(function (e) {
          showToast(e.message || 'Ошибка', 'error');
        });
    });
    refreshIcons();
  }

  function renderAutoposts() {
    var main = qs('#mainContent');
    if (!main) return;
    main.innerHTML = '<div class="dash-loading muted">Загрузка…</div>';
    Promise.all([getJson('/autoposts'), getJson('/channels').catch(function () { return { channels: [] }; })])
      .then(function (pair) {
        if (currentRoute !== 'autoposts') return;
        var posts = pair[0].posts || [];
        var chans = pair[1].channels || channelsCache;
        channelsCache = chans.length ? chans : channelsCache;
        var sel = chans
          .map(function (c) {
            return (
              '<option value="' + esc(String(c.chat_id)) + '">' + esc(c.title || String(c.chat_id)) + '</option>'
            );
          })
          .join('');
        var html = '<h2>Автопосты</h2>';
        html += '<div class="card-like mb-md" style="background:var(--bg-surface);border:1px solid var(--border-subtle);border-radius:var(--radius-md);padding:1rem">';
        html += '<h3 style="margin-top:0">Создать</h3>';
        html += '<div class="form-row">';
        html += '<div class="form-group"><label>Канал</label><select class="select" id="ap_chat">' + sel + '</select></div>';
        html +=
          '<div class="form-group"><label>Расписание (ISO)</label><input class="input mono" id="ap_when" placeholder="2026-05-20T12:00:00"/></div>';
        html += '</div>';
        html += '<div class="form-group"><label>Текст</label><textarea class="textarea" id="ap_text"></textarea></div>';
        html += '<div class="form-group"><label>Повтор</label><select class="select" id="ap_repeat">';
        html += '<option value="none">Нет</option><option value="daily">Ежедневно</option>';
        html += '<option value="weekly">Еженедельно</option><option value="monthly">Ежемесячно</option>';
        html += '</select></div>';
        html += '<button type="button" class="btn btn-primary" id="ap_create">Запланировать</button></div>';
        html += '<div class="table-wrap"><table><thead><tr>';
        html += '<th>Канал</th><th>Текст</th><th>Время</th><th>Повтор</th><th>Статус</th><th></th>';
        html += '</tr></thead><tbody>';
        posts.forEach(function (p) {
          html += '<tr>';
          html += '<td>' + esc(p.channel_title || String(p.chat_id)) + '</td>';
          html += '<td style="max-width:220px;overflow:hidden;text-overflow:ellipsis">' + esc(p.text) + '</td>';
          html += '<td class="mono text-sm">' + esc(p.scheduled_at) + '</td>';
          html += '<td>' + esc(p.repeat) + '</td>';
          html += '<td>' + esc(p.status) + '</td>';
          html +=
            '<td><button type="button" class="btn btn-danger btn-sm" data-del-ap="' +
            esc(p.id) +
            '">Удалить</button></td>';
          html += '</tr>';
        });
        if (!posts.length) html += '<tr><td colspan="6" class="muted">Пусто</td></tr>';
        html += '</tbody></table></div>';
        main.innerHTML = html;
        qs('#ap_create', main).addEventListener('click', function () {
          var chat_id = Number(qs('#ap_chat', main).value);
          var text = (qs('#ap_text', main).value || '').trim();
          var scheduled_at = (qs('#ap_when', main).value || '').trim();
          var repeat = qs('#ap_repeat', main).value || 'none';
          if (!chat_id || !text || !scheduled_at) {
            showToast('Заполните все поля', 'error');
            return;
          }
          postJson('/autoposts', { chat_id: chat_id, text: text, scheduled_at: scheduled_at, repeat: repeat })
            .then(function () {
              showToast('Создано', 'success');
              renderAutoposts();
            })
            .catch(function (e) {
              showToast(e.message || 'Ошибка', 'error');
            });
        });
        qsa('[data-del-ap]', main).forEach(function (b) {
          b.addEventListener('click', function () {
            var id = b.getAttribute('data-del-ap');
            deleteReq('/autoposts/' + encodeURIComponent(id))
              .then(function () {
                showToast('Удалено', 'success');
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
        main.innerHTML = '<p class="muted">Ошибка</p>';
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
          html +=
            '<div class="integration-card connected"><div class="int-card-header"><div class="int-logo max">М</div><div class="int-info"><div class="int-name">MAX</div><div class="int-desc">Основная платформа — подключён</div></div><span class="int-status connected"><i data-lucide="circle-check"></i> Подключён</span></div><div class="int-meta"><span>Каналов: <strong>' +
            esc(String((intMaxMeta && intMaxMeta.channelCount) || 0)) +
            '</strong></span><span>Bot Token: <code>••••••••' +
            esc((intMaxMeta && intMaxMeta.tokenPreview) || '') +
            '</code></span></div></div></div>';
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
        refreshIcons();
      })
      .catch(function (err) {
        if (err && err.message === 'auth') return;
        main.innerHTML = '<p class="muted">Ошибка: ' + esc(err.message || '') + '</p>';
      });
  }

  function integrationCardHtml(platform, title, desc, record, prefix) {
    var connected = record && record.status === 'connected';
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
      '</span></div><div class="int-body hidden" id="' +
      prefix +
      '-form"><div class="form-group"><label>' +
      (platform === 'vk' ? 'Access Token' : 'Bot Token') +
      '</label><input class="input mono" type="password" id="' +
      prefix +
      '-token"/></div>';

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
    return (
      html +
      '<div class="analytics-stats"><div class="a-stat"><div class="a-stat-val">' +
      esc(String(stats.totalPosts)) +
      '</div><div class="a-stat-label">постов</div></div><div class="a-stat"><div class="a-stat-val">' +
      esc(String(stats.forwarded)) +
      '</div><div class="a-stat-label">переслано</div></div><div class="a-stat"><div class="a-stat-val">' +
      esc(String(stats.channels)) +
      '</div><div class="a-stat-label">каналов</div></div></div></div>';
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
        if (!token) { showToast('Укажите токен', 'error'); return; }
        postJsonAbs(API_INTEGRATIONS + '/connect', body)
          .then(function () { showToast('Подключено', 'success'); renderIntegrations(); })
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
      '</select></div><div class="form-group"><label>Канал</label><input class="input" id="fb_src_channel" placeholder="@channel"/></div>' +
      '<div class="form-group"><label>Слова</label><input class="input" id="fb_kw"/></div><label>Исключить</label><input class="input" id="fb_ex"/></div>' +
      '<label class="checkbox-label"><input type="checkbox" id="fb_media"/> Только медиа</label>' +
      '<div class="form-group"><label>MAX-канал</label><select class="select" id="fb_dest_channel">' +
      maxChannels.map(function (c) { return '<option value="' + esc(c.id) + '">' + esc(c.title) + '</option>'; }).join('') +
      '</select></div><div class="form-group"><label>Подпись</label><input class="input" id="fb_signature"/></div>' +
      '<div class="builder-actions"><button type="button" class="btn btn-primary" id="fb_save">Создать</button><button type="button" class="btn btn-ghost" id="fb_cancel">Отмена</button></div>';
    host.innerHTML = host.innerHTML.replace(//, '<div class="form-group">').replace('', '');
    var srcPlatform = qs('#fb_src_platform', host);
    var srcInt = qs('#fb_src_int', host);
    if (srcPlatform) {
      srcPlatform.addEventListener('change', function () {
        var list = srcPlatform.value === 'vk' ? vkGroups : tgBots;
        srcInt.innerHTML = list.map(function (b) { return '<option value="' + esc(b.id) + '">' + esc(b.name) + '</option>'; }).join('');
      });
    }
    qs('#fb_cancel', host).addEventListener('click', function () { host.classList.add('hidden'); host.innerHTML = ''; });
    qs('#fb_save', host).addEventListener('click', function () {
      var platform = srcPlatform.value;
      var integrationId = srcInt.value;
      var channel = (qs('#fb_src_channel', host).value || '').trim();
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

  function renderUsers() {
    var main = qs('#mainContent');
    if (!main) return;
    main.innerHTML = '<div class="dash-loading muted">Загрузка…</div>';
    getJson('/users')
      .then(function (data) {
        if (currentRoute !== 'users') return;
        usersCache = data.users || [];
        var html = '<h2>Пользователи</h2><div class="table-wrap"><table><thead><tr>';
        html += '<th>ID</th><th>Имя</th><th>Роль</th><th>Связи</th><th></th></tr></thead><tbody>';
        usersCache.forEach(function (u) {
          html += '<tr>';
          html += '<td class="mono">' + esc(String(u.user_id)) + '</td>';
          html += '<td>' + esc(u.name || '—') + '</td>';
          html += '<td>' + esc(u.role) + '</td>';
          var links = (u.channel_links || [])
            .map(function (l) {
              return esc((l.channel_title || l.chat_id) + ': ' + (l.relations || []).join(', '));
            })
            .join('<br/>');
          html += '<td class="text-sm">' + (links || esc(u.context_hint || '—')) + '</td>';
          html += '<td>';
          if (u.role !== 'owner') {
            html +=
              '<button type="button" class="btn btn-danger btn-sm" data-del-user="' +
              esc(String(u.user_id)) +
              '">Удалить</button>';
          } else {
            html += '<span class="muted">—</span>';
          }
          html += '</td></tr>';
        });
        if (!usersCache.length) html += '<tr><td colspan="5" class="muted">Нет пользователей</td></tr>';
        html += '</tbody></table></div>';
        main.innerHTML = html;
        qsa('[data-del-user]', main).forEach(function (b) {
          b.addEventListener('click', function () {
            var uid = Number(b.getAttribute('data-del-user'));
            showConfirm(
              'Удалить пользователя?',
              'Пользователь ' + uid + ' будет отключён от бота.',
              function () {
                postJson('/users/remove', { user_id: uid })
                  .then(function () {
                    showToast('Пользователь удалён', 'success');
                    renderUsers();
                  })
                  .catch(function (e) {
                    showToast(e.message || 'Ошибка', 'error');
                  });
              },
            );
          });
        });
        refreshIcons();
      })
      .catch(function (err) {
        if (err && err.message === 'auth') return;
        main.innerHTML = '<p class="muted">Ошибка</p>';
      });
  }

  function renderLogs() {
    var main = qs('#mainContent');
    if (!main) return;
    main.innerHTML =
      '<div class="search-bar">' +
      '<select class="select" id="log_level" style="max-width:140px"><option value="">Все уровни</option>' +
      '<option value="INFO">INFO</option><option value="WARN">WARN</option><option value="ERROR">ERROR</option></select>' +
      '<input class="input" id="log_filter" placeholder="Фильтр текста" style="max-width:220px"/>' +
      '<input class="input mono" id="log_limit" style="max-width:100px" placeholder="200" value="200"/>' +
      '<button type="button" class="btn btn-primary" id="log_run">Загрузить</button></div>' +
      '<div class="log-viewer" id="log_body"></div>';
    function run() {
      var level = (qs('#log_level', main) && qs('#log_level', main).value) || '';
      var filter = (qs('#log_filter', main) && qs('#log_filter', main).value) || '';
      var lim = (qs('#log_limit', main) && qs('#log_limit', main).value) || '200';
      var q =
        '/logs?limit=' +
        encodeURIComponent(lim) +
        (level ? '&level=' + encodeURIComponent(level) : '') +
        (filter ? '&filter=' + encodeURIComponent(filter) : '');
      var body = qs('#log_body', main);
      body.textContent = 'Загрузка…';
      getJson(q)
        .then(function (data) {
          var lines = data.lines || [];
          body.textContent = '';
          lines.forEach(function (line) {
            var div = document.createElement('div');
            div.className = 'log-line';
            if (line.indexOf(' [INFO] ') !== -1) div.className += ' level-info';
            else if (line.indexOf(' [WARN] ') !== -1) div.className += ' level-warn';
            else if (line.indexOf(' [ERROR] ') !== -1) div.className += ' level-error';
            else if (line.indexOf(' [DEBUG] ') !== -1) div.className += ' level-debug';
            div.textContent = line;
            body.appendChild(div);
          });
          if (!lines.length) body.textContent = 'Нет строк';
        })
        .catch(function (e) {
          body.textContent = e.message || 'Ошибка';
        });
    }
    qs('#log_run', main).addEventListener('click', run);
    run();
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
    if (currentRoute === 'dashboard') {
      setTopbarActions(
        '<div class="period-tabs">' +
          '<button type="button" class="period-tab' +
          (dashPeriodDays === 7 ? ' active' : '') +
          '" data-days="7">7 дн.</button>' +
          '<button type="button" class="period-tab' +
          (dashPeriodDays === 30 ? ' active' : '') +
          '" data-days="30">30 дн.</button>' +
          '<button type="button" class="period-tab' +
          (dashPeriodDays === 0 ? ' active' : '') +
          '" data-days="0">Всё время</button></div>',
      );
      var tb = qs('#topbarActions');
      if (tb) {
        qsa('.period-tab', tb).forEach(function (b) {
          b.addEventListener('click', function () {
            dashPeriodDays = Number(b.getAttribute('data-days'));
            if (currentRoute === 'dashboard') {
              renderTopbarForRoute();
              renderDashboard(true);
            }
          });
        });
      }
    } else {
      setTopbarActions('');
    }
  }

  function handleRoute() {
    var next = parseHashRoute();
    if (next !== currentRoute) {
      clearDashTimer();
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
    } else if (currentRoute === 'channels') {
      renderChannels();
    } else if (currentRoute === 'tgchains') {
      renderTgChains();
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
