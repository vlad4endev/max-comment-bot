/**
 * Autoposting hub — professional scheduling UI for Telegram channels.
 * Loaded before admin.js; invoked via window.AutopostHub.render().
 */
(function () {
  'use strict';

  var AP_UI_BUILD = '20260619-platform-v5';
  var API_BASE = '/api/admin';
  var CHANNEL_COLORS = ['#534AB7', '#1D9E75', '#BA7517', '#7F77DD', '#3B82F6', '#EC4899'];
  var WEEKDAY_LABELS = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
  var WEEKDAY_LABELS_MON = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

  var state = {
    tab: 'schedule',
    posts: [],
    channels: [],
    templates: [],
    channelsHint: null,
    stats: null,
    filters: { search: '', channelId: '', status: '', scheduleType: '', from: '', to: '' },
    postsPage: 1,
    postsPerPage: 15,
    editingId: null,
    modalOpen: false,
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
  function fmtTime(iso) {
    if (!iso) return '—';
    var t = Date.parse(iso);
    if (!Number.isFinite(t)) return '—';
    return new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }
  function fmtDateTime(iso) {
    if (!iso) return '—';
    var t = Date.parse(iso);
    if (!Number.isFinite(t)) return String(iso);
    return new Date(t).toLocaleString('ru-RU', {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }
  function fmtDateInput(d) {
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }
  function isToday(iso) {
    var t = Date.parse(iso);
    if (!Number.isFinite(t)) return false;
    var d = new Date(t);
    var now = new Date();
    return d.getDate() === now.getDate() && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  }
  function truncate(s, n) {
    s = String(s || '').trim();
    if (s.length <= n) return s;
    return s.slice(0, n - 1) + '…';
  }
  function toast(msg, type) {
    if (window.AdminShell && window.AdminShell.showToast) {
      window.AdminShell.showToast(msg, type);
    }
    var root = qs('#toastRoot');
    if (!root) return;
    var el = document.createElement('div');
    el.className = 'toast ' + (type || 'info');
    el.textContent = msg;
    root.appendChild(el);
    setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 4500);
  }
  function confirmDlg(title, body, onOk) {
    if (window.AdminShell && window.AdminShell.showConfirm) {
      window.AdminShell.showConfirm(title, body, onOk);
    } else if (window.confirm(body)) {
      onOk();
    }
  }
  function refreshIcons(root) {
    if (typeof lucide !== 'undefined' && lucide.createIcons) {
      try {
        lucide.createIcons(root ? { root: root, attrs: { 'stroke-width': 2 } } : { attrs: { 'stroke-width': 2 } });
      } catch (_e) {
        lucide.createIcons({ attrs: { 'stroke-width': 2 } });
      }
    }
  }

  function apiGet(path) {
    return fetch(API_BASE + path, { credentials: 'same-origin' }).then(function (r) {
      if (r.status === 401) throw new Error('auth');
      return r.json().then(function (j) {
        if (!r.ok) throw new Error((j && j.error) || 'Ошибка запроса');
        return j;
      });
    });
  }
  function apiDelete(path) {
    return fetch(API_BASE + path, { method: 'DELETE', credentials: 'same-origin' }).then(function (r) {
      if (r.status === 401) throw new Error('auth');
      return r.json().then(function (j) {
        if (!r.ok) throw new Error((j && j.error) || 'Ошибка');
        return j;
      });
    });
  }
  function apiPatch(path, body) {
    return fetch(API_BASE + path, {
      method: 'PATCH', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(function (r) {
      if (r.status === 401) throw new Error('auth');
      return r.json().then(function (j) {
        if (!r.ok) throw new Error((j && j.error) || (j && j.message) || 'Ошибка');
        return j;
      });
    });
  }
  function apiPostForm(path, fd) {
    return fetch(API_BASE + path, { method: 'POST', credentials: 'same-origin', body: fd }).then(function (r) {
      if (r.status === 401) throw new Error('auth');
      return r.json().then(function (j) {
        if (!r.ok) throw new Error((j && j.error) || (j && j.message) || 'Ошибка');
        return j;
      });
    });
  }

  function parseTab() {
    var raw = (location.hash || '').replace(/^#/, '');
    var parts = raw.split('/');
    if (parts[0] !== 'autoposts') return 'schedule';
    var tab = parts[1] || 'schedule';
    var allowed = { schedule: 1, posts: 1, series: 1, stats: 1, channels: 1 };
    return allowed[tab] ? tab : 'schedule';
  }

  function navigateTab(tab) {
    var hash = tab === 'schedule' ? 'autoposts' : 'autoposts/' + tab;
    if (location.hash.replace(/^#/, '') !== hash) {
      location.hash = hash;
    } else {
      state.tab = tab;
      render();
    }
  }

  function channelColor(chId, idx) {
    var i = typeof idx === 'number' ? idx : state.channels.findIndex(function (c) { return String(c.id) === String(chId); });
    return CHANNEL_COLORS[(i >= 0 ? i : 0) % CHANNEL_COLORS.length];
  }

  function channelLabel(ch) {
    if (!ch) return '—';
    if (ch.username) return '@' + ch.username;
    return ch.title || ch.id;
  }

  function channelPlatform(ch) {
    return (ch && ch.platform) || 'telegram';
  }

  function platformLabel(platform) {
    return platform === 'max' ? 'MAX' : 'Telegram';
  }

  function channelsForPlatform(platform) {
    return state.channels.filter(function (c) {
      return channelPlatform(c) === platform;
    });
  }

  function postChannelName(p) {
    return p.channel_title || p.target_channel_id || '—';
  }

  function statusDotClass(status) {
    if (status === 'active') return 'active';
    if (status === 'paused') return 'paused';
    if (status === 'sent') return 'sent';
    if (status === 'failed') return 'failed';
    return 'draft';
  }

  function statusLabel(status) {
    var m = { active: 'Активен', sent: 'Отправлен', paused: 'Пауза', failed: 'Ошибка' };
    return m[status] || status;
  }

  function loadTemplatesFromApi() {
    return apiGet('/autoposts/templates').then(function (r) {
      state.templates = r.templates || [];
      return state.templates;
    }).catch(function () {
      state.templates = [];
      return [];
    });
  }

  function renderSidebar() {
    var tabs = [
      { id: 'schedule', icon: 'calendar', label: 'Расписание' },
      { id: 'posts', icon: 'list', label: 'Все посты' },
      { id: 'series', icon: 'repeat', label: 'Серии' },
      { id: 'stats', icon: 'bar-chart-2', label: 'Статистика' },
      { id: 'channels', icon: 'radio', label: 'Каналы' },
    ];
    var html = '<div class="ap-sidebar-title"><i data-lucide="calendar-clock"></i> Автопостинг</div>';
    html += '<p class="ap-nav-label">Навигация</p>';
    tabs.forEach(function (t) {
      html += '<button type="button" class="ap-nav-item' + (state.tab === t.id ? ' active' : '') + '" data-ap-tab="' + t.id + '">';
      html += '<i data-lucide="' + t.icon + '"></i> ' + esc(t.label) + '</button>';
    });
    html += '<p class="ap-nav-label">Мои каналы</p>';
    if (!state.channels.length) {
      html += '<div class="ap-channel-item muted">Нет каналов</div>';
    } else {
      state.channels.forEach(function (c, i) {
        html += '<div class="ap-channel-item" title="' + esc(channelLabel(c)) + '">';
        html += '<span class="ap-channel-dot" style="background:' + channelColor(c.id, i) + '"></span>';
        html += esc(channelLabel(c));
        html += ' <span class="ap-platform-tag ap-platform-' + esc(channelPlatform(c)) + '">' + esc(platformLabel(channelPlatform(c))) + '</span>';
        html += '</div>';
      });
    }
    html += '<button type="button" class="ap-channel-add" data-ap-goto-integrations>+ Добавить канал</button>';
    html += '<div class="ap-ui-build" title="Версия UI автопостинга">' + esc(AP_UI_BUILD) + '</div>';
    return html;
  }

  function renderMetricsRow(stats) {
    var s = stats || {};
    return '<div class="ap-metrics">' +
      '<div class="ap-metric"><div class="label">Запланировано</div><div class="value">' + (s.scheduledCount || 0) + '</div></div>' +
      '<div class="ap-metric"><div class="label">Активных серий</div><div class="value">' + (s.activeSeries || 0) + '</div></div>' +
      '<div class="ap-metric"><div class="label">Успешных отправок</div><div class="value">' + (s.successRate != null ? s.successRate + '%' : '—') + '</div></div>' +
      '<div class="ap-metric"><div class="label">Подключённых каналов</div><div class="value">' + (s.connectedChannels || state.channels.length) + '</div></div>' +
      '</div>';
  }

  function renderUpcomingList() {
    var today = state.posts.filter(function (p) {
      return p.status === 'active' && isToday(p.scheduled_at);
    }).sort(function (a, b) {
      return Date.parse(a.scheduled_at) - Date.parse(b.scheduled_at);
    });
    if (!today.length) {
      return '<div class="ap-empty"><i data-lucide="calendar-off"></i><h4>Нет постов на сегодня</h4>' +
        '<p>Запланируйте публикацию или создайте серию</p>' +
        '<button type="button" class="ap-btn-primary" style="width:auto;display:inline-block" data-ap-new-post>Создать пост</button></div>';
    }
    var html = '';
    today.forEach(function (p) {
      var ci = state.channels.findIndex(function (c) { return String(c.id) === String(p.target_channel_id); });
      var color = channelColor(p.target_channel_id, ci);
      html += '<div class="ap-upcoming-item">';
      html += '<span class="ap-upcoming-time">' + esc(fmtTime(p.scheduled_at)) + '</span>';
      html += '<span class="ap-upcoming-stripe" style="background:' + color + '"></span>';
      html += '<span class="ap-upcoming-text" title="' + esc(p.text) + '">' + esc(truncate(p.text || '—', 60)) + '</span>';
      html += '<span class="ap-upcoming-channel">' + esc(postChannelName(p)) + '</span>';
      html += '<button type="button" class="ap-menu-btn" data-ap-menu="' + esc(p.id) + '" title="Действия"><i data-lucide="more-vertical"></i></button>';
      html += '</div>';
    });
    return html;
  }

  function renderQuickForm() {
    if (!state.quickPlatform) state.quickPlatform = 'telegram';
    var quickPlatform = state.quickPlatform;
    var filtered = channelsForPlatform(quickPlatform);
    var opts = filtered.map(function (c) {
      return '<option value="' + esc(String(c.id)) + '">' + esc(channelLabel(c)) + '</option>';
    }).join('');
    if (!opts) opts = '<option value="">— нет каналов ' + esc(platformLabel(quickPlatform)) + ' —</option>';
    var now = new Date();
    now.setMinutes(now.getMinutes() + 30);
    var dtLocal = fmtDateInput(now) + 'T' + String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
    return '<div class="form-group"><label>Мессенджер</label><div class="ap-platform-tabs" id="apQuickPlatform">' +
      '<button type="button" class="ap-platform-tab' + (quickPlatform === 'telegram' ? ' active' : '') + '" data-qplatform="telegram">Telegram</button>' +
      '<button type="button" class="ap-platform-tab' + (quickPlatform === 'max' ? ' active' : '') + '" data-qplatform="max">MAX</button></div></div>' +
      '<div class="form-group"><label>Канал</label><select class="select" id="apQuickChannel">' + opts + '</select></div>' +
      '<div class="form-group"><label>Текст поста</label><textarea class="textarea" id="apQuickText" rows="4" placeholder="Введите текст…"></textarea></div>' +
      '<label class="muted text-sm">Тип</label>' +
      '<div class="ap-schedule-types" id="apQuickTypes">' +
      '<button type="button" class="ap-schedule-type active" data-qtype="once">📅 Разово</button>' +
      '<button type="button" class="ap-schedule-type" data-qtype="daily">🔄 Ежедневно</button>' +
      '<button type="button" class="ap-schedule-type" data-qtype="weekly">🗓 Еженедельно</button>' +
      '</div>' +
      '<div class="form-row" id="apQuickOnce">' +
      '<div class="form-group"><label>Дата</label><input type="date" class="input" id="apQuickDate" value="' + fmtDateInput(now) + '"/></div>' +
      '<div class="form-group"><label>Время</label><input type="time" class="input" id="apQuickTime" value="' + String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0') + '"/></div>' +
      '</div>' +
      '<div id="apQuickRecur" class="hidden">' +
      '<div class="form-group"><label>Время</label><input type="time" class="input" id="apQuickRecurTime" value="09:00"/></div>' +
      '<div class="ap-weekdays" id="apQuickWd"></div></div>' +
      '<button type="button" class="ap-btn-primary" id="apQuickSubmit" style="margin-top:0.75rem">Запланировать</button>';
  }

  function renderSeriesTable() {
    var series = state.posts.filter(function (p) { return p.schedule_type === 'recurring'; });
    if (!series.length) {
      return '<div class="ap-empty"><i data-lucide="repeat"></i><h4>Нет активных серий</h4><p>Создайте повторяющийся пост</p></div>';
    }
    var html = '<div class="ap-table-wrap"><table class="ap-table"><thead><tr>' +
      '<th>Название</th><th>Канал</th><th>Дни</th><th>Время</th><th>Условия</th><th>Статус</th><th>Действия</th></tr></thead><tbody>';
    series.forEach(function (p) {
      var days = (p.weekdays || []).map(function (d) { return WEEKDAY_LABELS[d]; }).join(', ');
      var dot = p.status === 'active' ? 'active' : p.status === 'paused' ? 'paused' : 'draft';
      html += '<tr>';
      html += '<td>' + esc(truncate(p.text || 'Без названия', 40)) + '</td>';
      html += '<td>' + esc(postChannelName(p)) + '</td>';
      html += '<td>' + esc(days || '—') + '</td>';
      html += '<td class="mono">' + esc(p.recurring_time || '—') + '</td>';
      html += '<td class="muted">—</td>';
      html += '<td><span class="ap-status-dot ' + dot + '"></span>' + esc(statusLabel(p.status)) + '</td>';
      html += '<td class="ap-actions">';
      html += '<button type="button" class="btn btn-ghost btn-sm" data-ap-edit="' + esc(p.id) + '">Редактировать</button>';
      if (p.status === 'active') {
        html += '<button type="button" class="btn btn-ghost btn-sm" data-ap-pause="' + esc(p.id) + '">Пауза</button>';
      } else if (p.status === 'paused' || p.status === 'failed') {
        html += '<button type="button" class="btn btn-ghost btn-sm" data-ap-resume="' + esc(p.id) + '">Старт</button>';
      }
      html += '<button type="button" class="btn btn-danger btn-sm" data-ap-del="' + esc(p.id) + '">Удалить</button>';
      html += '</td></tr>';
    });
    html += '</tbody></table></div>';
    return html;
  }

  function renderSchedulePage() {
    return renderMetricsRow(state.stats) +
      '<div class="ap-grid-2">' +
      '<div class="ap-card"><h3>Ближайшие посты сегодня</h3>' + renderUpcomingList() + '</div>' +
      '<div class="ap-card"><h3>Быстрый постинг</h3>' + renderQuickForm() + '</div>' +
      '</div>' +
      '<div class="ap-card"><h3>Серии</h3>' + renderSeriesTable() + '</div>';
  }

  function renderPostsFilters() {
    var chOpts = '<option value="">Все каналы</option>' + state.channels.map(function (c) {
      return '<option value="' + esc(String(c.id)) + '"' + (state.filters.channelId === String(c.id) ? ' selected' : '') + '>' + esc(channelLabel(c)) + '</option>';
    }).join('');
    return '<div class="ap-filters">' +
      '<input type="search" class="input search" id="apFilterSearch" placeholder="Поиск по тексту…" value="' + esc(state.filters.search) + '"/>' +
      '<select class="select" id="apFilterChannel">' + chOpts + '</select>' +
      '<select class="select" id="apFilterStatus">' +
      '<option value="">Все статусы</option>' +
      '<option value="active"' + (state.filters.status === 'active' ? ' selected' : '') + '>Активен</option>' +
      '<option value="paused"' + (state.filters.status === 'paused' ? ' selected' : '') + '>Пауза</option>' +
      '<option value="sent"' + (state.filters.status === 'sent' ? ' selected' : '') + '>Отправлен</option>' +
      '<option value="failed"' + (state.filters.status === 'failed' ? ' selected' : '') + '>Ошибка</option>' +
      '</select>' +
      '<select class="select" id="apFilterType">' +
      '<option value="">Все типы</option>' +
      '<option value="once"' + (state.filters.scheduleType === 'once' ? ' selected' : '') + '>Разово</option>' +
      '<option value="recurring"' + (state.filters.scheduleType === 'recurring' ? ' selected' : '') + '>Серия</option>' +
      '</select>' +
      '<input type="date" class="input" id="apFilterFrom" value="' + esc(state.filters.from) + '" title="С даты"/>' +
      '<input type="date" class="input" id="apFilterTo" value="' + esc(state.filters.to) + '" title="По дату"/>' +
      '</div>';
  }

  function getFilteredPosts() {
    var list = state.posts.slice();
    var f = state.filters;
    if (f.search) {
      var q = f.search.toLowerCase();
      list = list.filter(function (p) { return (p.text || '').toLowerCase().includes(q); });
    }
    if (f.channelId) {
      list = list.filter(function (p) { return String(p.target_channel_id) === f.channelId; });
    }
    if (f.status) list = list.filter(function (p) { return p.status === f.status; });
    if (f.scheduleType) list = list.filter(function (p) { return p.schedule_type === f.scheduleType; });
    if (f.from) {
      var fromMs = Date.parse(f.from);
      if (Number.isFinite(fromMs)) list = list.filter(function (p) { return Date.parse(p.scheduled_at) >= fromMs; });
    }
    if (f.to) {
      var toMs = Date.parse(f.to + 'T23:59:59');
      if (Number.isFinite(toMs)) list = list.filter(function (p) { return Date.parse(p.scheduled_at) <= toMs; });
    }
    return list.sort(function (a, b) { return Date.parse(b.scheduled_at) - Date.parse(a.scheduled_at); });
  }

  function renderPostsPage() {
    var filtered = getFilteredPosts();
    var totalPages = Math.max(1, Math.ceil(filtered.length / state.postsPerPage));
    if (state.postsPage > totalPages) state.postsPage = totalPages;
    var start = (state.postsPage - 1) * state.postsPerPage;
    var page = filtered.slice(start, start + state.postsPerPage);

    var html = renderPostsFilters();
    if (!filtered.length) {
      html += '<div class="ap-empty"><i data-lucide="file-text"></i><h4>Постов не найдено</h4>' +
        '<p>Измените фильтры или создайте новый пост</p>' +
        '<button type="button" class="ap-btn-primary" style="width:auto;display:inline-block" data-ap-new-post>Создать пост</button></div>';
      return html;
    }
    html += '<div class="ap-table-wrap"><table class="ap-table"><thead><tr>' +
      '<th>Платформа</th><th>Текст</th><th>Канал</th><th>Дата и время</th><th>Тип</th><th>Статус</th><th>Действия</th></tr></thead><tbody>';
    page.forEach(function (p) {
      var ci = state.channels.findIndex(function (c) { return String(c.id) === String(p.target_channel_id); });
      var color = channelColor(p.target_channel_id, ci);
      var typeBadge = p.schedule_type === 'recurring' ? 'ap-badge-series' : 'ap-badge-once';
      var typeLabel = p.schedule_type === 'recurring' ? 'Серия' : 'Разово';
      html += '<tr>';
      html += '<td><span class="ap-platform-tag ap-platform-' + esc(p.platform || 'telegram') + '">' + esc(platformLabel(p.platform || 'telegram')) + '</span></td>';
      html += '<td style="max-width:220px" title="' + esc(p.text) + '">' + esc(truncate(p.text || '—', 50)) + '</td>';
      html += '<td><span class="ap-channel-dot" style="background:' + color + ';display:inline-block;vertical-align:middle"></span> ' + esc(postChannelName(p)) + '</td>';
      html += '<td class="mono text-sm">' + esc(fmtDateTime(p.scheduled_at)) + '</td>';
      html += '<td><span class="ap-badge ' + typeBadge + '">' + typeLabel + '</span></td>';
      html += '<td><span class="ap-status-dot ' + statusDotClass(p.status) + '"></span>' + esc(statusLabel(p.status)) + '</td>';
      html += '<td class="ap-actions">';
      html += '<button type="button" class="btn btn-ghost btn-sm" data-ap-edit="' + esc(p.id) + '">Редактировать</button>';
      html += '<button type="button" class="btn btn-ghost btn-sm" data-ap-dup="' + esc(p.id) + '">Дублировать</button>';
      html += '<button type="button" class="btn btn-danger btn-sm" data-ap-del="' + esc(p.id) + '">Удалить</button>';
      html += '</td></tr>';
    });
    html += '</tbody></table></div>';
    html += '<div class="ap-pagination">';
    html += '<button type="button"' + (state.postsPage <= 1 ? ' disabled' : '') + ' data-ap-page="' + (state.postsPage - 1) + '">← Пред</button>';
    for (var pg = 1; pg <= Math.min(totalPages, 5); pg++) {
      html += '<button type="button" class="' + (pg === state.postsPage ? 'active' : '') + '" data-ap-page="' + pg + '">' + pg + '</button>';
    }
    if (totalPages > 5) html += '<span class="muted">…</span>';
    html += '<button type="button"' + (state.postsPage >= totalPages ? ' disabled' : '') + ' data-ap-page="' + (state.postsPage + 1) + '">След →</button>';
    html += '</div>';
    return html;
  }

  function renderSeriesPage() {
    return '<div class="ap-page-header"><h2>Серии</h2><button type="button" class="ap-topbar-btn" data-ap-new-post><i data-lucide="plus"></i> Новая серия</button></div>' +
      renderSeriesTable();
  }

  function renderStatsPage() {
    var s = state.stats || {};
    var html = renderMetricsRow({
      scheduledCount: s.totalSent || 0,
      activeSeries: s.successRate != null ? s.successRate + '%' : '—',
      successRate: s.totalSent || 0,
      connectedChannels: (s.byChannel && s.byChannel.length) || 0,
    });
    html = '<div class="ap-metrics">' +
      '<div class="ap-metric"><div class="label">Отправлено всего</div><div class="value">' + (s.totalSent || 0) + '</div></div>' +
      '<div class="ap-metric"><div class="label">Успешных доставок</div><div class="value">' + (s.successRate != null ? s.successRate + '%' : '—') + '</div></div>' +
      '<div class="ap-metric"><div class="label">Реакции</div><div class="value muted">N/A</div></div>' +
      '<div class="ap-metric"><div class="label">CTR кнопок</div><div class="value muted">N/A</div></div>' +
      '</div>';
    html += '<div class="ap-grid-2">';
    html += '<div class="ap-card"><h3>Отправки по каналам</h3>';
    var byCh = s.byChannel || [];
    if (!byCh.length) {
      html += '<p class="muted">Нет данных</p>';
    } else {
      var maxSent = Math.max.apply(null, byCh.map(function (c) { return c.sent; }).concat([1]));
      html += '<div class="ap-bar-chart">';
      byCh.forEach(function (c) {
        var pct = Math.round((c.sent / maxSent) * 100);
        html += '<div class="ap-bar-row">';
        html += '<span class="ap-bar-label">' + esc(truncate(c.title, 14)) + '</span>';
        html += '<div class="ap-bar-track"><div class="ap-bar-fill" style="width:' + pct + '%"></div></div>';
        html += '<span class="ap-bar-value">' + c.sent + '</span></div>';
      });
      html += '</div>';
    }
    html += '</div>';
    html += '<div class="ap-card"><h3>Лучшее время публикации</h3>';
    html += renderHeatmap(s.heatmap);
    html += '</div></div>';
    return html;
  }

  function renderHeatmap(matrix) {
    var hours = ['09', '12', '15', '18', '21'];
    var mat = matrix || [];
    var max = 1;
    mat.forEach(function (row) {
      row.forEach(function (v) { if (v > max) max = v; });
    });
    var html = '<div class="ap-heatmap">';
    html += '<div></div>';
    hours.forEach(function (h) { html += '<div class="ap-heatmap-header">' + h + '</div>'; });
    for (var d = 0; d < 7; d++) {
      html += '<div class="ap-heatmap-day">' + WEEKDAY_LABELS_MON[d] + '</div>';
      for (var c = 0; c < 5; c++) {
        var v = (mat[d] && mat[d][c]) || 0;
        var intensity = max > 0 ? v / max : 0;
        var bg = 'rgba(127,119,221,' + (0.08 + intensity * 0.85) + ')';
        html += '<div class="ap-heatmap-cell" style="background:' + bg + '" title="' + v + ' отправок"></div>';
      }
    }
    html += '</div>';
    return html;
  }

  function renderChannelsPage() {
    var templates = state.templates;
    var html = '<div class="ap-grid-2">';
    html += '<div class="ap-card"><h3>Мои каналы</h3>';
    if (state.channelsHint) {
      html += '<p class="text-sm" style="color:var(--warning)">' + esc(state.channelsHint) + '</p>';
    }
    if (!state.channels.length) {
      html += '<div class="ap-empty"><i data-lucide="radio"></i><h4>Каналы не подключены</h4>' +
        '<p>Подключите Telegram в разделе «Интеграции» и добавьте бота админом</p>' +
        '<button type="button" class="ap-btn-primary" style="width:auto;display:inline-block" data-ap-goto-integrations>Перейти в интеграции</button></div>';
    } else {
      state.channels.forEach(function (c, i) {
        html += '<div class="ap-channel-card">';
        html += '<div class="ap-channel-card-icon"><i data-lucide="send"></i></div>';
        html += '<div style="flex:1;min-width:0"><div style="font-weight:600">' + esc(channelLabel(c)) + '</div>';
        html += '<div class="text-sm muted">' + esc(platformLabel(channelPlatform(c))) + ' · Активен</div></div>';
        html += '<button type="button" class="btn btn-ghost btn-sm" data-ap-goto-integrations>Настройки</button>';
        html += '</div>';
      });
      html += '<button type="button" class="ap-btn-primary" style="margin-top:0.5rem" data-ap-goto-integrations>Подключить новый канал</button>';
    }
    html += '</div>';
    html += '<div class="ap-card"><h3>Шаблоны постов</h3>';
    if (!templates.length) {
      html += '<p class="muted text-sm">Нет сохранённых шаблонов</p>';
    } else {
      templates.forEach(function (t) {
        html += '<div class="ap-template-item"><span>📄 ' + esc(t.name) + '</span>';
        html += '<button type="button" class="btn btn-ghost btn-sm" data-ap-edit-template="' + esc(t.id) + '">Изменить</button></div>';
      });
    }
    html += '<button type="button" class="btn btn-ghost" style="margin-top:0.5rem" data-ap-new-template>+ Создать шаблон</button>';
    html += '</div></div>';
    return html;
  }

  function renderContent() {
    switch (state.tab) {
      case 'posts': return renderPostsPage();
      case 'series': return renderSeriesPage();
      case 'stats': return renderStatsPage();
      case 'channels': return renderChannelsPage();
      default: return renderSchedulePage();
    }
  }

  function buildWeekdayHtml(prefix, selected) {
    var sel = selected || [1, 2, 3, 4, 5];
    var html = '';
    for (var d = 0; d <= 6; d++) {
      var checked = sel.indexOf(d) >= 0;
      html += '<label class="ap-weekday' + (checked ? ' checked' : '') + '">';
      html += '<input type="checkbox" class="' + prefix + '_wd" value="' + d + '"' + (checked ? ' checked' : '') + '/>';
      html += WEEKDAY_LABELS[d] + '</label>';
    }
    return html;
  }

  function openPostModal(editPost) {
    var host = qs('#modalRoot');
    if (!host) return;
    host.innerHTML = '';
    state.editingId = editPost && editPost.id ? editPost.id : null;
    state.modalOpen = true;
    document.body.classList.add('ap-modal-open');
    var p = editPost || {};
    var initPlatform = p.platform === 'max' ? 'max' : 'telegram';
    var initPlatformChannels = channelsForPlatform(initPlatform);
    var selectedChannels = editPost
      ? [String(p.target_channel_id)]
      : (initPlatformChannels[0] ? [String(initPlatformChannels[0].id)] : []);
    var today = fmtDateInput(new Date());
    var schedType = 'once';
    if (p.schedule_type === 'recurring') {
      var wds = p.weekdays || [];
      schedType = wds.length >= 7 ? 'daily' : 'weekly';
    }
    var onceDate = today;
    var onceTime = '12:00';
    if (p.scheduled_at && p.schedule_type !== 'recurring') {
      var sd = new Date(p.scheduled_at);
      if (Number.isFinite(sd.getTime())) {
        onceDate = fmtDateInput(sd);
        onceTime = String(sd.getHours()).padStart(2, '0') + ':' + String(sd.getMinutes()).padStart(2, '0');
      }
    }

    var backdrop = document.createElement('div');
    backdrop.className = 'ap-modal-backdrop';
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');

    var modal = document.createElement('div');
    modal.className = 'ap-modal';
    modal.innerHTML =
      '<div class="ap-modal-header"><h2>' + (editPost && editPost.id ? 'Редактировать пост' : 'Новый пост') + '</h2>' +
      '<button type="button" class="ap-modal-close" data-ap-modal-close><i data-lucide="x"></i></button></div>' +
      '<div class="ap-modal-body" id="apModalBody"></div>' +
      '<div class="ap-modal-preview-wrap">' +
      '<div class="ap-modal-preview-label" id="apModalPreviewLabel">Как будет выглядеть в Telegram</div>' +
      '<div class="ap-preview-telegram" id="apModalPreview"></div>' +
      '</div>' +
      '<div id="apModalStatus" class="ap-modal-status hidden" role="alert"></div>' +
      '<div class="ap-modal-footer">' +
      '<span class="ap-modal-build">' + esc(AP_UI_BUILD) + '</span>' +
      '<div class="ap-modal-footer-actions">' +
      '<button type="button" class="btn btn-ghost" data-ap-modal-close>Отмена</button>' +
      '<button type="button" class="btn btn-ghost" data-ap-save-draft>Сохранить как черновик</button>' +
      '<button type="button" class="ap-topbar-btn" data-ap-submit-post>Запланировать ▶</button>' +
      '</div></div>';

    backdrop.appendChild(modal);
    host.appendChild(backdrop);

    var modalState = {
      platform: initPlatform,
      text: p.text || '',
      channels: selectedChannels.slice(),
      scheduleType: schedType,
      onceDate: onceDate,
      onceTime: onceTime,
      dailyTimes: p.recurring_time ? [p.recurring_time] : ['09:00'],
      weekdays: p.weekdays && p.weekdays.length ? p.weekdays.slice() : [1, 2, 3, 4, 5],
      startDate: '',
      endDate: '',
      conditions: [],
      mediaFiles: [],
      btnText: (p.inline_button && p.inline_button.text) || '',
      btnUrl: (p.inline_button && p.inline_button.url) || '',
      onFailure: 'skip',
    };

    function showModalStatus(msg, type) {
      var el = qs('#apModalStatus', modal);
      if (!el) {
        toast(msg, type || 'error');
        return;
      }
      el.textContent = msg;
      el.className = 'ap-modal-status ' + (type || 'error');
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    function hideModalStatus() {
      var el = qs('#apModalStatus', modal);
      if (el) el.className = 'ap-modal-status hidden';
    }

    function snapshotFromDom() {
      var body = qs('#apModalBody', modal);
      if (!body) return;
      var editorMount = qs('#apTextEditorMount', body);
      if (editorMount && window.ApTextEditor) {
        modalState.text = window.ApTextEditor.getHtml(editorMount.querySelector('.ap-editor-surface'));
      } else {
        var ta = qs('#apModalText', body);
        if (ta) modalState.text = ta.value;
      }
      var st = modalState.scheduleType;
      if (st === 'once') {
        var dateEl = qs('#apModalDate', body);
        var timeEl = qs('#apModalTime', body);
        if (dateEl) modalState.onceDate = dateEl.value;
        if (timeEl) modalState.onceTime = timeEl.value;
      } else if (st === 'daily') {
        var startEl = qs('#apModalStart', body);
        var endEl = qs('#apModalEnd', body);
        if (startEl) modalState.startDate = startEl.value;
        if (endEl) modalState.endDate = endEl.value;
      } else if (st === 'weekly') {
        var weeklyTime = qs('#apModalWeeklyTime', body);
        if (weeklyTime) modalState.dailyTimes[0] = weeklyTime.value;
        var wStart = qs('#apModalWStart', body);
        var wEnd = qs('#apModalWEnd', body);
        if (wStart) modalState.startDate = wStart.value;
        if (wEnd) modalState.endDate = wEnd.value;
        var picked = [];
        qsa('.apmodal_wd:checked', body).forEach(function (cb) { picked.push(Number(cb.value)); });
        modalState.weekdays = picked;
      }
      var btnTextEl = qs('#apBtnText', body);
      var btnUrlEl = qs('#apBtnUrl', body);
      if (btnTextEl) modalState.btnText = btnTextEl.value;
      if (btnUrlEl) modalState.btnUrl = btnUrlEl.value;
      var onFail = qs('#apOnFailure', body);
      if (onFail) modalState.onFailure = onFail.value;
      var activePlatform = qs('[data-ap-platform].active', body);
      if (activePlatform) {
        modalState.platform = activePlatform.getAttribute('data-ap-platform') === 'max' ? 'max' : 'telegram';
      }
    }

    function syncWeekdaysFromDom(body) {
      var picked = [];
      qsa('.apmodal_wd:checked', body).forEach(function (cb) { picked.push(Number(cb.value)); });
      modalState.weekdays = picked;
    }

    function updateModalPreview() {
      var wrap = qs('#apModalPreview', modal);
      if (!wrap) return;
      var text = (modalState.text || '').trim();
      var btnText = (modalState.btnText || '').trim();
      var btnUrl = (modalState.btnUrl || '').trim();
      var media = modalState.mediaFiles || [];
      var html = '';

      if (media.length) {
        if (media.length === 1) {
          var single = media[0];
          if (single.preview) {
            html += '<div class="ap-preview-media-single"><img src="' + single.preview + '" alt=""/></div>';
          } else if (single.file && single.file.type && single.file.type.indexOf('video/') === 0) {
            html += '<div class="ap-preview-media-single ap-preview-video"><span>🎬 ' + esc(single.file.name || 'Видео') + '</span></div>';
          } else {
            html += '<div class="ap-preview-media-single ap-preview-file"><span>📎 ' + esc((single.file && single.file.name) || 'Файл') + '</span></div>';
          }
        } else {
          html += '<div class="ap-preview-media-album">';
          media.forEach(function (m) {
            if (m.preview) {
              html += '<img src="' + m.preview + '" alt=""/>';
            } else {
              html += '<div class="ap-preview-album-placeholder">' + (m.file && m.file.type && m.file.type.indexOf('video/') === 0 ? '🎬' : '📎') + '</div>';
            }
          });
          html += '</div>';
        }
      }

      if (text && !(window.ApTextEditor && window.ApTextEditor.isEmpty(text))) {
        var previewText = window.ApTextEditor
          ? window.ApTextEditor.previewHtml(text)
          : esc(text);
        html += '<div class="ap-preview-bubble ap-preview-formatted">' + previewText + '</div>';
      } else if (!media.length && !(btnText && btnUrl)) {
        html += '<div class="ap-preview-bubble ap-preview-placeholder">Добавьте текст, фото или кнопку</div>';
      }

      if (btnText && btnUrl) {
        html += '<div class="ap-preview-inline"><span class="ap-preview-inline-btn">' + esc(btnText) + '</span></div>';
      } else if (btnText) {
        html += '<div class="ap-preview-inline"><span class="ap-preview-inline-btn ap-preview-inline-incomplete">Укажите URL кнопки</span></div>';
      }

      wrap.innerHTML = html;
      qsa('.ap-spoiler', wrap).forEach(function (el) {
        el.addEventListener('click', function () { el.classList.toggle('revealed'); });
      });
    }

    function updatePreviewLabel() {
      var lbl = qs('#apModalPreviewLabel', modal);
      if (lbl) lbl.textContent = 'Как будет выглядеть в ' + platformLabel(modalState.platform);
    }

    function renderModalForm() {
      var body = qs('#apModalBody', modal);
      if (!body) return;
      var st = modalState.scheduleType;
      var platformChannels = channelsForPlatform(modalState.platform);
      modalState.channels = modalState.channels.filter(function (cid) {
        var ch = state.channels.find(function (c) { return String(c.id) === cid; });
        return ch && channelPlatform(ch) === modalState.platform;
      });
      if (!modalState.channels.length && platformChannels.length) {
        modalState.channels = [String(platformChannels[0].id)];
      }
      var chips = modalState.channels.map(function (cid) {
        var c = state.channels.find(function (ch) { return String(ch.id) === cid; });
        var ci = state.channels.findIndex(function (ch) { return String(ch.id) === cid; });
        return '<span class="ap-channel-chip"><span class="ap-channel-dot" style="background:' + channelColor(cid, ci) + '"></span>' +
          esc(c ? channelLabel(c) : cid) +
          '<button type="button" data-rm-ch="' + esc(cid) + '">✕</button></span>';
      }).join('');
      var addOpts = platformChannels.filter(function (c) {
        return modalState.channels.indexOf(String(c.id)) < 0;
      }).map(function (c) {
        return '<option value="' + esc(String(c.id)) + '">' + esc(channelLabel(c)) + '</option>';
      }).join('');

      body.innerHTML =
        '<section class="ap-form-section" id="apSecPlatform"><h3>Мессенджер</h3>' +
        '<div class="ap-platform-tabs">' +
        '<button type="button" class="ap-platform-tab' + (modalState.platform === 'telegram' ? ' active' : '') + '" data-ap-platform="telegram">Telegram</button>' +
        '<button type="button" class="ap-platform-tab' + (modalState.platform === 'max' ? ' active' : '') + '" data-ap-platform="max">MAX</button>' +
        '</div>' +
        '<p class="text-sm muted ap-platform-hint">Пост уйдёт только в выбранный мессенджер</p></section>' +
        '<section class="ap-form-section" id="apSecChannels"><h3>Каналы · ' + esc(platformLabel(modalState.platform)) + '</h3>' +
        '<div class="ap-channel-chips" id="apModalChips">' + (chips || '<span class="muted text-sm">Нет каналов ' + esc(platformLabel(modalState.platform)) + '</span>') + '</div>' +
        (addOpts ? '<select class="select" id="apAddChannel"><option value="">+ Добавить канал</option>' + addOpts + '</select>' : '') +
        '</section>' +
        '<section class="ap-form-section" id="apSecText"><h3>Текст</h3>' +
        '<div id="apTextEditorMount" class="ap-text-editor-mount"></div>' +
        '<textarea class="textarea hidden" id="apModalText" rows="4">' + esc(modalState.text) + '</textarea>' +
        '<div class="ap-char-count"><span id="apCharCount">0</span> символов · <span class="muted">Telegram & MAX HTML</span></div></section>' +
        '<section class="ap-form-section" id="apSecSchedule"><h3>Расписание</h3>' +
        '<div class="ap-schedule-types" id="apModalSchedTypes">' +
        '<button type="button" class="ap-schedule-type' + (st === 'once' ? ' active' : '') + '" data-mst="once">📅 Разово</button>' +
        '<button type="button" class="ap-schedule-type' + (st === 'daily' ? ' active' : '') + '" data-mst="daily">🔄 Ежедневно</button>' +
        '<button type="button" class="ap-schedule-type' + (st === 'weekly' ? ' active' : '') + '" data-mst="weekly">🗓 По дням</button>' +
        '</div>' +
        '<div id="apModalOnce" class="ap-schedule-panel' + (st !== 'once' ? ' hidden' : '') + '">' +
        '<div class="form-row"><div class="form-group"><label>Дата</label><input type="date" class="input" id="apModalDate" value="' + esc(modalState.onceDate) + '"/></div>' +
        '<div class="form-group"><label>Время</label><input type="time" class="input" id="apModalTime" value="' + esc(modalState.onceTime) + '"/></div></div></div>' +
        '<div id="apModalDaily" class="ap-schedule-panel' + (st !== 'daily' ? ' hidden' : '') + '">' +
        '<label>Время публикации</label><div class="ap-time-chips" id="apDailyChips"></div>' +
        '<button type="button" class="btn btn-ghost btn-sm" id="apAddDailyTime">+ Ещё время</button>' +
        '<div class="form-row"><div class="form-group"><label>Дата начала</label><input type="date" class="input" id="apModalStart" value="' + esc(modalState.startDate) + '"/></div>' +
        '<div class="form-group"><label>Дата окончания</label><input type="date" class="input" id="apModalEnd" value="' + esc(modalState.endDate) + '"/></div></div></div>' +
        '<div id="apModalWeekly" class="ap-schedule-panel' + (st !== 'weekly' ? ' hidden' : '') + '">' +
        '<label>Дни недели</label><div class="ap-weekdays" id="apModalWd">' + buildWeekdayHtml('apmodal', modalState.weekdays) + '</div>' +
        '<div class="form-group"><label>Время</label><input type="time" class="input" id="apModalWeeklyTime" value="' + esc(modalState.dailyTimes[0] || '09:00') + '"/></div>' +
        '<div class="form-row"><div class="form-group"><label>Дата начала</label><input type="date" class="input" id="apModalWStart" value="' + esc(modalState.startDate) + '"/></div>' +
        '<div class="form-group"><label>Дата окончания</label><input type="date" class="input" id="apModalWEnd" value="' + esc(modalState.endDate) + '"/></div></div></div>' +
        '</section>' +
        '<section class="ap-form-section" id="apSecMedia"><h3>Медиа и кнопка</h3>' +
        '<div class="ap-dropzone" id="apDropzone">Нажмите или перетащите фото/видео<br><span class="text-sm muted">До 10 файлов</span></div>' +
        '<input type="file" id="apModalMedia" multiple accept="image/*,video/*" class="hidden"/>' +
        '<div class="ap-media-grid" id="apMediaGrid"></div>' +
        '<div class="form-row" style="margin-top:0.75rem">' +
        '<div class="form-group"><label>Текст кнопки</label><input class="input" id="apBtnText" placeholder="Открыть сайт" value="' + esc(modalState.btnText) + '"/></div>' +
        '<div class="form-group"><label>URL кнопки</label><input class="input" id="apBtnUrl" placeholder="https://…" value="' + esc(modalState.btnUrl) + '"/></div></div>' +
        '</section>';

      var ta = qs('#apModalText', body);
      var editorWrap = qs('#apTextEditorMount', body);
      var editorSurface = null;
      var previewTimer = null;
      function updateTextField() {
        if (editorSurface && window.ApTextEditor) {
          modalState.text = window.ApTextEditor.getHtml(editorSurface);
          var cnt = qs('#apCharCount', body);
          if (cnt) cnt.textContent = String(window.ApTextEditor.getPlainLength(editorSurface));
        } else if (ta) {
          modalState.text = ta.value;
          var cnt2 = qs('#apCharCount', body);
          if (cnt2) cnt2.textContent = String(modalState.text.length);
        }
        updateModalPreview();
      }
      if (editorWrap && window.ApTextEditor) {
        editorSurface = window.ApTextEditor.mount(editorWrap, {
          value: modalState.text,
          placeholder: 'Введите текст публикации…',
          onChange: updateTextField,
        });
        updateTextField();
      } else if (ta) {
        ta.addEventListener('input', function () {
          if (previewTimer) clearTimeout(previewTimer);
          previewTimer = setTimeout(updateTextField, 150);
        });
        updateTextField();
      }

      qsa('[data-ap-platform]', body).forEach(function (btn) {
        btn.addEventListener('click', function () {
          snapshotFromDom();
          var next = btn.getAttribute('data-ap-platform') === 'max' ? 'max' : 'telegram';
          if (next === modalState.platform) return;
          modalState.platform = next;
          modalState.channels = [];
          renderModalForm();
        });
      });

      var addSel = qs('#apAddChannel', body);
      if (addSel) {
        addSel.addEventListener('change', function () {
          var v = addSel.value;
          if (v && modalState.channels.indexOf(v) < 0) {
            modalState.channels.push(v);
            renderModalForm();
          }
        });
      }
      qsa('[data-rm-ch]', body).forEach(function (btn) {
        btn.addEventListener('click', function () {
          modalState.channels = modalState.channels.filter(function (c) { return c !== btn.getAttribute('data-rm-ch'); });
          renderModalForm();
        });
      });

      qsa('[data-mst]', body).forEach(function (btn) {
        btn.addEventListener('click', function () {
          snapshotFromDom();
          modalState.scheduleType = btn.getAttribute('data-mst');
          qsa('[data-mst]', body).forEach(function (b) {
            b.classList.toggle('active', b === btn);
          });
          qsa('.ap-schedule-panel', body).forEach(function (p) { p.classList.add('hidden'); });
          var panelId = { once: 'apModalOnce', daily: 'apModalDaily', weekly: 'apModalWeekly' }[modalState.scheduleType];
          var panel = panelId ? qs('#' + panelId, body) : null;
          if (panel) panel.classList.remove('hidden');
        });
      });

      function renderDailyChips() {
        var wrap = qs('#apDailyChips', body);
        if (!wrap) return;
        wrap.innerHTML = modalState.dailyTimes.map(function (t, i) {
          return '<span class="ap-time-chip">⏰ ' + esc(t) + '<button type="button" data-rm-time="' + i + '">✕</button></span>';
        }).join('');
        qsa('[data-rm-time]', wrap).forEach(function (b) {
          b.addEventListener('click', function () {
            modalState.dailyTimes.splice(Number(b.getAttribute('data-rm-time')), 1);
            if (!modalState.dailyTimes.length) modalState.dailyTimes.push('09:00');
            renderDailyChips();
          });
        });
      }
      renderDailyChips();
      var addTime = qs('#apAddDailyTime', body);
      if (addTime) {
        addTime.addEventListener('click', function () {
          var t = prompt('Время (ЧЧ:ММ)', '14:00');
          if (t && /^\d{1,2}:\d{2}$/.test(t)) {
            modalState.dailyTimes.push(t);
            renderDailyChips();
          }
        });
      }

      qsa('.apmodal_wd', body).forEach(function (cb) {
        cb.addEventListener('change', function () {
          var lbl = cb.closest('.ap-weekday');
          if (lbl) lbl.classList.toggle('checked', cb.checked);
          syncWeekdaysFromDom(body);
        });
      });
      qsa('.ap-weekday', body).forEach(function (lbl) {
        lbl.addEventListener('click', function () {
          setTimeout(function () {
            var cb = lbl.querySelector('.apmodal_wd');
            if (cb) lbl.classList.toggle('checked', cb.checked);
            syncWeekdaysFromDom(body);
          }, 0);
        });
      });

      qsa('#apModalDate, #apModalTime, #apModalStart, #apModalEnd, #apModalWeeklyTime, #apModalWStart, #apModalWEnd', body).forEach(function (el) {
        el.addEventListener('change', snapshotFromDom);
      });

      var dz = qs('#apDropzone', body);
      var fileInput = qs('#apModalMedia', body);
      function renderMediaGrid() {
        var grid = qs('#apMediaGrid', body);
        if (!grid) return;
        grid.innerHTML = modalState.mediaFiles.map(function (f, i) {
          var url = f.preview || '';
          return '<div class="ap-media-thumb">' + (url ? '<img src="' + url + '" alt=""/>' : '📎') +
            '<button type="button" data-rm-media="' + i + '">✕</button></div>';
        }).join('');
        qsa('[data-rm-media]', grid).forEach(function (b) {
          b.addEventListener('click', function () {
            modalState.mediaFiles.splice(Number(b.getAttribute('data-rm-media')), 1);
            renderMediaGrid();
            updateModalPreview();
          });
        });
      }
      function addFiles(files) {
        for (var i = 0; i < files.length && modalState.mediaFiles.length < 10; i++) {
          var f = files[i];
          modalState.mediaFiles.push({
            file: f,
            preview: f.type.startsWith('image/') ? URL.createObjectURL(f) : null,
          });
        }
        renderMediaGrid();
        updateModalPreview();
      }
      if (dz && fileInput) {
        dz.addEventListener('click', function () { fileInput.click(); });
        dz.addEventListener('dragover', function (e) { e.preventDefault(); dz.classList.add('dragover'); });
        dz.addEventListener('dragleave', function () { dz.classList.remove('dragover'); });
        dz.addEventListener('drop', function (e) {
          e.preventDefault();
          dz.classList.remove('dragover');
          if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
        });
        fileInput.addEventListener('change', function () {
          if (fileInput.files) addFiles(fileInput.files);
        });
      }
      renderMediaGrid();

      qsa('#apBtnText, #apBtnUrl', body).forEach(function (el) {
        el.addEventListener('input', function () {
          snapshotFromDom();
          updateModalPreview();
        });
      });

      refreshIcons(body);
      updateModalPreview();
      updatePreviewLabel();
    }

    function closeModal() {
      state.modalOpen = false;
      document.body.classList.remove('ap-modal-open');
      if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
      host.innerHTML = '';
      state.editingId = null;
    }

    function submitPost(asDraft) {
      snapshotFromDom();
      hideModalStatus();
      var text = (modalState.text || '').trim();
      var textEmpty = window.ApTextEditor ? window.ApTextEditor.isEmpty(text) : !text;
      var submitBtn = qs('[data-ap-submit-post]', modal);
      var draftBtn = qs('[data-ap-save-draft]', modal);
      if (!modalState.channels.length) {
        showModalStatus('Выберите хотя бы один канал', 'error');
        var sec = qs('#apSecChannels', modal);
        if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      var btnText = (modalState.btnText || '').trim();
      var btnUrl = (modalState.btnUrl || '').trim();
      var mediaCount = modalState.mediaFiles.length;
      if (textEmpty && !mediaCount) {
        showModalStatus('Введите текст или добавьте фото/видео', 'error');
        var secText = qs('#apSecText', modal);
        if (secText) secText.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      if (mediaCount > 1 && btnText && btnUrl && modalState.platform === 'telegram') {
        showModalStatus('Инлайн-кнопка недоступна для альбома из нескольких файлов в Telegram', 'error');
        return;
      }

      var st = modalState.scheduleType;
      if (st === 'once' && !modalState.onceDate) {
        showModalStatus('Укажите дату публикации', 'error');
        var secSched = qs('#apSecSchedule', modal);
        if (secSched) secSched.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      if (st === 'weekly' && !modalState.weekdays.length) {
        showModalStatus('Выберите хотя бы один день недели', 'error');
        var secSched2 = qs('#apSecSchedule', modal);
        if (secSched2) secSched2.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }

      if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Сохранение…'; }
      if (draftBtn) draftBtn.disabled = true;
      var promises = modalState.channels.map(function (channelId) {
        var fd = new FormData();
        fd.append('target_channel_id', channelId);
        fd.append('platform', modalState.platform);
        var ch = state.channels.find(function (c) { return String(c.id) === channelId; });
        if (ch) fd.append('channel_title', channelLabel(ch));
        fd.append('text', text);
        if (st === 'once') {
          fd.append('schedule_type', 'once');
          fd.append('scheduled_at', new Date(modalState.onceDate + 'T' + (modalState.onceTime || '12:00')).toISOString());
        } else {
          fd.append('schedule_type', 'recurring');
          var time = st === 'weekly'
            ? (modalState.dailyTimes[0] || '09:00')
            : (modalState.dailyTimes[0] || '09:00');
          var weekdays = st === 'weekly'
            ? modalState.weekdays.slice()
            : [0, 1, 2, 3, 4, 5, 6];
          fd.append('recurring_time', time);
          fd.append('weekdays', JSON.stringify(weekdays));
          var probe = new Date();
          var parts = time.split(':');
          probe.setHours(Number(parts[0]), Number(parts[1]), 0, 0);
          fd.append('scheduled_at', probe.toISOString());
        }
        if (btnText && btnUrl) {
          fd.append('inline_button_text', btnText);
          fd.append('inline_button_url', btnUrl);
        }
        modalState.mediaFiles.forEach(function (m) {
          if (m.file) fd.append('media', m.file);
        });
        if (state.editingId && modalState.channels.length === 1) {
          return fetch(API_BASE + '/autoposts/' + encodeURIComponent(state.editingId), {
            method: 'PATCH', credentials: 'same-origin', body: fd,
          }).then(function (r) {
            return r.json().then(function (j) {
              if (!r.ok) throw new Error((j && j.error) || 'Ошибка');
              return j;
            });
          });
        }
        return apiPostForm('/autoposts', fd);
      });

      Promise.all(promises)
        .then(function () {
          toast(asDraft ? 'Черновик сохранён' : 'Пост запланирован', 'success');
          closeModal();
          loadAndRender();
        })
        .catch(function (e) {
          showModalStatus(e.message || 'Ошибка сохранения', 'error');
          toast(e.message || 'Ошибка сохранения', 'error');
        })
        .finally(function () {
          if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Запланировать ▶'; }
          if (draftBtn) draftBtn.disabled = false;
        });
    }

    qsa('[data-ap-modal-close]', modal).forEach(function (btn) {
      btn.addEventListener('click', closeModal);
    });
    backdrop.addEventListener('click', function (e) {
      if (e.target === backdrop) closeModal();
    });
    modal.addEventListener('click', function (e) {
      e.stopPropagation();
    });
    document.addEventListener('keydown', function onEsc(e) {
      if (e.key === 'Escape') {
        closeModal();
        document.removeEventListener('keydown', onEsc);
      }
    });
    qs('[data-ap-submit-post]', modal).addEventListener('click', function () { submitPost(false); });
    qs('[data-ap-save-draft]', modal).addEventListener('click', function () { submitPost(true); });

    renderModalForm();
    refreshIcons(modal);
  }

  function openTemplateModal(templateId) {
    var t = templateId ? state.templates.find(function (x) { return x.id === templateId; }) : null;
    var name = t ? t.name : '';
    var text = t ? t.text : '';
    var newName = prompt('Название шаблона', name || 'Новый шаблон');
    if (!newName) return;
    var newText = prompt('Текст шаблона', text || '');
    if (newText === null) return;
    var url = t
      ? API_BASE + '/autoposts/templates/' + encodeURIComponent(t.id)
      : API_BASE + '/autoposts/templates';
    fetch(url, {
      method: t ? 'PATCH' : 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName, text: newText }),
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error((j && j.error) || 'Ошибка');
        return j;
      });
    }).then(function () {
      toast('Шаблон сохранён', 'success');
      loadAndRender();
    }).catch(function (e) { toast(e.message || 'Ошибка', 'error'); });
  }

  function bindPostActions(root) {
    qsa('[data-ap-del]', root).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-ap-del');
        confirmDlg('Удалить пост?', 'Пост будет удалён безвозвратно.', function () {
          apiDelete('/autoposts/' + encodeURIComponent(id))
            .then(function () { toast('Удалено', 'success'); loadAndRender(); })
            .catch(function (e) { toast(e.message, 'error'); });
        });
      });
    });
    qsa('[data-ap-pause]', root).forEach(function (btn) {
      btn.addEventListener('click', function () {
        apiPatch('/autoposts/' + encodeURIComponent(btn.getAttribute('data-ap-pause')) + '/pause', {})
          .then(function () { toast('На паузе', 'success'); loadAndRender(); })
          .catch(function (e) { toast(e.message, 'error'); });
      });
    });
    qsa('[data-ap-resume]', root).forEach(function (btn) {
      btn.addEventListener('click', function () {
        apiPatch('/autoposts/' + encodeURIComponent(btn.getAttribute('data-ap-resume')) + '/resume', {})
          .then(function () { toast('Возобновлено', 'success'); loadAndRender(); })
          .catch(function (e) { toast(e.message, 'error'); });
      });
    });
    qsa('[data-ap-edit]', root).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-ap-edit');
        var post = state.posts.find(function (p) { return p.id === id; });
        if (post) openPostModal(post);
      });
    });
    qsa('[data-ap-dup]', root).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-ap-dup');
        var post = state.posts.find(function (p) { return p.id === id; });
        if (!post) return;
        var copy = Object.assign({}, post, { id: null });
        openPostModal(copy);
      });
    });
    qsa('[data-ap-new-post]', root).forEach(function (btn) {
      btn.addEventListener('click', function () { openPostModal(null); });
    });
    qsa('[data-ap-goto-integrations]', root).forEach(function (btn) {
      btn.addEventListener('click', function () { location.hash = 'integrations'; });
    });
    qsa('[data-ap-new-template]', root).forEach(function (btn) {
      btn.addEventListener('click', function () { openTemplateModal(null); });
    });
    qsa('[data-ap-edit-template]', root).forEach(function (btn) {
      btn.addEventListener('click', function () {
        openTemplateModal(btn.getAttribute('data-ap-edit-template'));
      });
    });
  }

  function bindScheduleExtras(root) {
    var quickTypes = qs('#apQuickTypes', root);
    if (quickTypes) {
      var qType = 'once';
      qsa('.ap-schedule-type', quickTypes).forEach(function (btn) {
        btn.addEventListener('click', function () {
          qType = btn.getAttribute('data-qtype');
          qsa('.ap-schedule-type', quickTypes).forEach(function (b) { b.classList.toggle('active', b === btn); });
          var once = qs('#apQuickOnce', root);
          var recur = qs('#apQuickRecur', root);
          if (once) once.classList.toggle('hidden', qType !== 'once');
          if (recur) recur.classList.toggle('hidden', qType === 'once');
        });
      });
      var wdWrap = qs('#apQuickWd', root);
      if (wdWrap) {
        wdWrap.innerHTML = buildWeekdayHtml('apquick', [1, 2, 3, 4, 5]);
        qsa('.apquick_wd', root).forEach(function (cb) {
          cb.addEventListener('change', function () {
            var lbl = cb.closest('.ap-weekday');
            if (lbl) lbl.classList.toggle('checked', cb.checked);
          });
        });
      }
      qsa('[data-qplatform]', root).forEach(function (btn) {
        btn.addEventListener('click', function () {
          state.quickPlatform = btn.getAttribute('data-qplatform') === 'max' ? 'max' : 'telegram';
          renderContentOnly();
        });
      });
      var submit = qs('#apQuickSubmit', root);
      if (submit) {
        submit.addEventListener('click', function () {
          var channelId = (qs('#apQuickChannel', root) && qs('#apQuickChannel', root).value || '').trim();
          var text = (qs('#apQuickText', root) && qs('#apQuickText', root).value || '').trim();
          if (!channelId) { toast('Выберите канал', 'error'); return; }
          if (!text) { toast('Введите текст', 'error'); return; }
          var fd = new FormData();
          fd.append('target_channel_id', channelId);
          fd.append('platform', state.quickPlatform || 'telegram');
          var ch = state.channels.find(function (c) { return String(c.id) === channelId; });
          if (ch) fd.append('channel_title', channelLabel(ch));
          fd.append('text', text);
          if (qType === 'once') {
            fd.append('schedule_type', 'once');
            var d = qs('#apQuickDate', root).value;
            var t = qs('#apQuickTime', root).value;
            fd.append('scheduled_at', new Date(d + 'T' + t).toISOString());
          } else {
            fd.append('schedule_type', 'recurring');
            var time = qType === 'weekly'
              ? (qs('#apQuickRecurTime', root) && qs('#apQuickRecurTime', root).value) || '09:00'
              : (qs('#apQuickRecurTime', root) && qs('#apQuickRecurTime', root).value) || '09:00';
            var weekdays = [];
            if (qType === 'weekly') {
              qsa('.apquick_wd:checked', root).forEach(function (cb) { weekdays.push(Number(cb.value)); });
            } else {
              weekdays = [0, 1, 2, 3, 4, 5, 6];
            }
            if (!weekdays.length) { toast('Выберите дни', 'error'); return; }
            fd.append('recurring_time', time);
            fd.append('weekdays', JSON.stringify(weekdays));
            var probe = new Date();
            var parts = time.split(':');
            probe.setHours(Number(parts[0]), Number(parts[1]), 0, 0);
            fd.append('scheduled_at', probe.toISOString());
          }
          apiPostForm('/autoposts', fd)
            .then(function () { toast('Запланировано', 'success'); loadAndRender(); })
            .catch(function (e) { toast(e.message, 'error'); });
        });
      }
    }

    qsa('[data-ap-tab]', root).forEach(function (btn) {
      btn.addEventListener('click', function () {
        navigateTab(btn.getAttribute('data-ap-tab'));
      });
    });

    var fSearch = qs('#apFilterSearch', root);
    if (fSearch) {
      fSearch.addEventListener('input', function () {
        state.filters.search = fSearch.value;
        state.postsPage = 1;
        renderContentOnly();
      });
    }
    ['apFilterChannel', 'apFilterStatus', 'apFilterType', 'apFilterFrom', 'apFilterTo'].forEach(function (id) {
      var el = qs('#' + id, root);
      if (!el) return;
      el.addEventListener('change', function () {
        state.filters.channelId = qs('#apFilterChannel', root) ? qs('#apFilterChannel', root).value : '';
        state.filters.status = qs('#apFilterStatus', root) ? qs('#apFilterStatus', root).value : '';
        state.filters.scheduleType = qs('#apFilterType', root) ? qs('#apFilterType', root).value : '';
        state.filters.from = qs('#apFilterFrom', root) ? qs('#apFilterFrom', root).value : '';
        state.filters.to = qs('#apFilterTo', root) ? qs('#apFilterTo', root).value : '';
        state.postsPage = 1;
        renderContentOnly();
      });
    });
    qsa('[data-ap-page]', root).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var pg = Number(btn.getAttribute('data-ap-page'));
        if (pg >= 1) { state.postsPage = pg; renderContentOnly(); }
      });
    });
  }

  function renderContentOnly() {
    var content = qs('#apContent');
    if (content) {
      content.innerHTML = renderContent();
      bindPostActions(content);
      bindScheduleExtras(content);
      refreshIcons(content);
    }
  }

  function renderShell() {
    var main = qs('#mainContent');
    if (!main) return;
    var headerBtn = state.tab === 'schedule' || state.tab === 'posts'
      ? '<button type="button" class="ap-topbar-btn" data-ap-new-post><i data-lucide="plus"></i> Новый пост</button>'
      : '';
    main.innerHTML =
      '<div class="ap-hub">' +
      '<aside class="ap-sidebar" id="apSidebar">' + renderSidebar() + '</aside>' +
      '<div class="ap-main">' +
      (state.tab !== 'schedule' ? '<div class="ap-page-header"><h2>' + esc({
        posts: 'Все посты', series: 'Серии', stats: 'Статистика', channels: 'Каналы и шаблоны',
      }[state.tab] || '') + '</h2>' + headerBtn + '</div>' : '') +
      '<div id="apContent">' + renderContent() + '</div>' +
      '</div></div>';
    bindPostActions(main);
    bindScheduleExtras(main);
    refreshIcons(main);
    if (window.AdminShell && window.AdminShell.setTopbarActions) {
      if (state.tab === 'schedule') {
        window.AdminShell.setTopbarActions(
          '<button type="button" class="ap-topbar-btn" data-ap-new-post><i data-lucide="plus"></i> Новый пост</button>'
        );
        qsa('[data-ap-new-post]', qs('#topbarActions') || document).forEach(function (btn) {
          btn.addEventListener('click', function () { openPostModal(null); });
        });
        refreshIcons(qs('#topbarActions'));
      } else {
        window.AdminShell.setTopbarActions('');
      }
    }
  }

  function loadAndRender() {
    var main = qs('#mainContent');
    if (main) main.innerHTML = '<div class="skeleton-page"><div class="skeleton-line"></div><div class="skeleton-line"></div></div>';
    return Promise.all([
      apiGet('/autoposts'),
      apiGet('/autoposts/channels').catch(function () { return { channels: [], hint: 'Не удалось загрузить каналы' }; }),
      apiGet('/autoposts/stats').catch(function () { return { stats: null }; }),
      loadTemplatesFromApi(),
    ]).then(function (results) {
      if (!isAutopostRoute()) return;
      state.posts = results[0].posts || [];
      state.channels = results[1].channels || [];
      state.channelsHint = results[1].hint || null;
      state.stats = results[2].stats || null;
      renderShell();
    }).catch(function (err) {
      if (err && err.message === 'auth') return;
      var main = qs('#mainContent');
      if (main) main.innerHTML = '<p class="muted">Ошибка загрузки автопостов</p>';
    });
  }

  function isAutopostRoute() {
    var raw = (location.hash || '').replace(/^#/, '');
    return raw === 'autoposts' || raw.indexOf('autoposts/') === 0;
  }

  function render() {
    state.tab = parseTab();
    loadAndRender();
  }

  window.addEventListener('hashchange', function () {
    if (state.modalOpen) return;
    if (isAutopostRoute() && window.AdminShell && window.AdminShell.getCurrentRoute() === 'autoposts') {
      state.tab = parseTab();
      renderShell();
    }
  });

  window.AutopostHub = {
    render: render,
    parseTab: parseTab,
    isAutopostRoute: isAutopostRoute,
  };
})();
