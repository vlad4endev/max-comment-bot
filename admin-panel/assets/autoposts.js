/**
 * Autoposting hub — professional scheduling UI for Telegram channels.
 * Loaded before admin.js; invoked via window.AutopostHub.render().
 */
(function () {
  'use strict';

  var AP_UI_BUILD = '20260817-flex-v1';
  var AP_TAG_COLORS = ['#7F77DD', '#1D9E75', '#BA7517', '#3B82F6', '#EC4899', '#EF4444', '#6B7280', '#EAB308'];
  var AP_DEFAULT_TZ = (typeof Intl !== 'undefined' && Intl.DateTimeFormat)
    ? (Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Moscow')
    : 'Europe/Moscow';
  var AP_TIMEZONES = [
    'Europe/Kaliningrad', 'Europe/Moscow', 'Europe/Samara', 'Asia/Yekaterinburg',
    'Asia/Omsk', 'Asia/Krasnoyarsk', 'Asia/Irkutsk', 'Asia/Yakutsk',
    'Asia/Vladivostok', 'Asia/Magadan', 'Asia/Kamchatka', 'UTC', 'Europe/Kyiv', 'Asia/Almaty',
  ];
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
    scheduler: null,
    filters: { search: '', channelId: '', status: '', scheduleType: '', tag: '', from: '', to: '' },
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

  function inlineRowsFromPost(p) {
    var raw = p && p.inline_buttons;
    if (Array.isArray(raw) && raw.length) {
      return raw.map(function (row) {
        var btns = (row || []).map(function (b) {
          return { text: (b && b.text) || '', url: (b && b.url) || '' };
        });
        if (btns.length >= 2) {
          return {
            layout: '2',
            buttons: [btns[0] || { text: '', url: '' }, btns[1] || { text: '', url: '' }],
          };
        }
        return { layout: '1', buttons: [btns[0] || { text: '', url: '' }] };
      });
    }
    if (p && p.inline_button && (p.inline_button.text || p.inline_button.url)) {
      return [{
        layout: '1',
        buttons: [{ text: p.inline_button.text || '', url: p.inline_button.url || '' }],
      }];
    }
    return [];
  }

  function serializeInlineKeyboard(rows) {
    if (!Array.isArray(rows) || !rows.length) return null;
    var out = [];
    rows.forEach(function (row) {
      var cells = [];
      var limit = row.layout === '2' ? 2 : 1;
      for (var i = 0; i < limit; i++) {
        var b = row.buttons && row.buttons[i];
        if (!b) continue;
        var text = (b.text || '').trim();
        var url = (b.url || '').trim();
        if (text && url && /^https?:\/\//i.test(url)) {
          cells.push({ text: text, url: url });
        }
      }
      if (cells.length) out.push(cells);
    });
    return out.length ? out : null;
  }

  function hasInlineKeyboard(rows) {
    return !!serializeInlineKeyboard(rows);
  }

  function hexToRgb(hex) {
    var h = String(hex || '').replace('#', '');
    if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
    var n = parseInt(h, 16);
    if (!Number.isFinite(n)) return { r: 127, g: 119, b: 221 };
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function tagInlineStyle(color) {
    var rgb = hexToRgb(color || AP_TAG_COLORS[0]);
    var c = color || AP_TAG_COLORS[0];
    return 'background:rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',0.18);border:1px solid rgba(' +
      rgb.r + ',' + rgb.g + ',' + rgb.b + ',0.42);color:' + c;
  }

  function normalizeTagList(tags) {
    if (!Array.isArray(tags)) return [];
    var out = [];
    var seen = {};
    tags.forEach(function (t) {
      if (!t || typeof t.name !== 'string') return;
      var name = t.name.trim().replace(/\s+/g, ' ').slice(0, 32);
      if (!name) return;
      var key = name.toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      var color = AP_TAG_COLORS.indexOf(t.color) >= 0 ? t.color : AP_TAG_COLORS[out.length % AP_TAG_COLORS.length];
      out.push({ name: name, color: color });
    });
    return out.slice(0, 10);
  }

  function renderPostTagsHtml(tags, emptyFallback) {
    var list = normalizeTagList(tags || []);
    if (!list.length) return emptyFallback ? '<span class="muted text-sm">—</span>' : '';
    return '<div class="ap-tags">' + list.map(function (t) {
      return '<span class="ap-tag" style="' + tagInlineStyle(t.color) + '">' + esc(t.name) + '</span>';
    }).join('') + '</div>';
  }

  function collectAllTagsFromPosts(posts) {
    var map = {};
    (posts || []).forEach(function (p) {
      normalizeTagList(p.tags).forEach(function (t) {
        map[t.name.toLowerCase()] = t;
      });
    });
    return Object.keys(map).sort().map(function (k) { return map[k]; });
  }

  function buildTagColorsHtml(activeColor) {
    return AP_TAG_COLORS.map(function (c) {
      return '<button type="button" class="ap-tag-color' + (c === activeColor ? ' active' : '') +
        '" data-tag-color="' + c + '" style="background:' + c + '" title="Цвет тега"></button>';
    }).join('');
  }

  function buildTagEditorHtml(tags, draftColor) {
    var list = normalizeTagList(tags);
    var chips = list.map(function (t, i) {
      return '<span class="ap-tag ap-tag--editable" style="' + tagInlineStyle(t.color) + '">' + esc(t.name) +
        '<button type="button" data-rm-tag="' + i + '" title="Удалить">✕</button></span>';
    }).join('');
    return '<div class="ap-tags ap-tags--editor" id="apTagList">' + (chips || '<span class="text-sm muted">Теги не добавлены</span>') + '</div>' +
      '<div class="ap-tag-add">' +
      '<input class="input" id="apTagInput" placeholder="Название тега" maxlength="32"/>' +
      '<div class="ap-tag-colors" id="apTagColors">' + buildTagColorsHtml(draftColor || AP_TAG_COLORS[0]) + '</div>' +
      '<button type="button" class="btn btn-ghost btn-sm" id="apTagAdd">Добавить</button>' +
      '</div>';
  }

  function buildInlineRowsEditorHtml(rows) {
    if (!rows.length) {
      return '<p class="text-sm muted ap-inline-empty">Нет кнопок. Добавьте ряд, если нужны ссылки под постом.</p>';
    }
    return rows.map(function (row, ri) {
      var layout2 = row.layout === '2';
      var btns = row.buttons || [{ text: '', url: '' }];
      if (layout2 && btns.length < 2) btns.push({ text: '', url: '' });
      var btnHtml = btns.slice(0, layout2 ? 2 : 1).map(function (b, bi) {
        return '<div class="ap-inline-btn-fields" data-inline-btn="' + bi + '">' +
          '<input class="input" data-inline-field="text" placeholder="Текст кнопки" value="' + esc(b.text || '') + '"/>' +
          '<input class="input" data-inline-field="url" placeholder="https://…" value="' + esc(b.url || '') + '"/>' +
          '</div>';
      }).join('');
      return '<div class="ap-inline-row" data-inline-row="' + ri + '">' +
        '<div class="ap-inline-row-head">' +
        '<span class="ap-inline-row-label">Ряд ' + (ri + 1) + '</span>' +
        '<div class="ap-inline-layout">' +
        '<button type="button" class="ap-inline-layout-btn' + (!layout2 ? ' active' : '') + '" data-inline-layout="1">1 кн.</button>' +
        '<button type="button" class="ap-inline-layout-btn' + (layout2 ? ' active' : '') + '" data-inline-layout="2">2 кн.</button>' +
        '</div>' +
        '<button type="button" class="ap-inline-row-rm" data-rm-inline-row="' + ri + '" title="Удалить ряд">✕</button>' +
        '</div>' +
        '<div class="ap-inline-row-body' + (layout2 ? ' ap-inline-row-body--2' : '') + '">' + btnHtml + '</div>' +
        '</div>';
    }).join('');
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
  function fmtDateTimeTz(iso, tz) {
    if (!iso) return '—';
    var t = Date.parse(iso);
    if (!Number.isFinite(t)) return String(iso);
    try {
      return new Date(t).toLocaleString('ru-RU', {
        timeZone: tz || AP_DEFAULT_TZ,
        day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
      });
    } catch (_e) {
      return fmtDateTime(iso);
    }
  }
  function partsInZone(iso, tz) {
    var d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    var fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz || AP_DEFAULT_TZ,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
    var map = {};
    fmt.formatToParts(d).forEach(function (p) { map[p.type] = p.value; });
    return {
      date: (map.year || '') + '-' + (map.month || '') + '-' + (map.day || ''),
      time: (map.hour || '12') + ':' + (map.minute || '00'),
    };
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
  function isOverdue(p) {
    if (!p || p.status !== 'active') return false;
    var t = Date.parse(p.scheduled_at);
    return Number.isFinite(t) && t < Date.now() - 2 * 60 * 1000;
  }
  function conditionSummary(p) {
    var bits = [];
    if (p.interval_hours) bits.push('каждые ' + p.interval_hours + ' ч');
    if (p.daily_times && p.daily_times.length > 1) bits.push(p.daily_times.join(', '));
    else if (p.recurring_time) bits.push(p.recurring_time);
    if (p.start_date || p.end_date) {
      bits.push((p.start_date || '…') + ' → ' + (p.end_date || '∞'));
    }
    if (p.repeat_limit) bits.push('лимит ' + p.repeat_limit);
    (p.conditions || []).forEach(function (c) {
      if (c.type === 'hours_range') bits.push('окно ' + c.value);
      if (c.type === 'min_interval_hours') bits.push('пауза ' + c.value + ' ч');
      if (c.type === 'max_posts_per_day') bits.push('≤' + c.value + '/день');
    });
    return bits.length ? bits.join(' · ') : '—';
  }
  function condValue(conditions, type) {
    var row = (conditions || []).find(function (c) { return c.type === type; });
    return row ? row.value : '';
  }
  function splitHoursRange(value) {
    var m = String(value || '').match(/(\d{1,2}:\d{2}|\d{1,2})\s*[-–]\s*(\d{1,2}:\d{2}|\d{1,2})/);
    if (!m) return { from: '', to: '' };
    function norm(s) { return s.indexOf(':') >= 0 ? s : (String(s).padStart(2, '0') + ':00'); }
    return { from: norm(m[1]), to: norm(m[2]) };
  }
  function tzOptionsHtml(selected) {
    var list = AP_TIMEZONES.slice();
    if (selected && list.indexOf(selected) < 0) list.unshift(selected);
    if (AP_DEFAULT_TZ && list.indexOf(AP_DEFAULT_TZ) < 0) list.unshift(AP_DEFAULT_TZ);
    return list.map(function (tz) {
      return '<option value="' + esc(tz) + '"' + (tz === selected ? ' selected' : '') + '>' + esc(tz) + '</option>';
    }).join('');
  }
  function postActionButtons(p, compact) {
    var html = '';
    html += '<button type="button" class="btn btn-ghost btn-sm" data-ap-edit="' + esc(p.id) + '">' + (compact ? 'Изм.' : 'Редактировать') + '</button>';
    if (p.status === 'active' || p.status === 'draft' || p.status === 'paused' || p.status === 'failed') {
      html += '<button type="button" class="btn btn-ghost btn-sm" data-ap-now="' + esc(p.id) + '" title="Опубликовать сейчас">Сейчас</button>';
    }
    if (p.status === 'active') {
      html += '<button type="button" class="btn btn-ghost btn-sm" data-ap-pause="' + esc(p.id) + '">Пауза</button>';
    } else if (p.status === 'paused' || p.status === 'failed' || p.status === 'draft') {
      html += '<button type="button" class="btn btn-ghost btn-sm" data-ap-resume="' + esc(p.id) + '">Запустить</button>';
    }
    html += '<button type="button" class="btn btn-ghost btn-sm" data-ap-dup="' + esc(p.id) + '">Копия</button>';
    html += '<button type="button" class="btn btn-danger btn-sm" data-ap-del="' + esc(p.id) + '">Удалить</button>';
    return html;
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
  function apiPostJson(path, body) {
    return fetch(API_BASE + path, {
      method: 'POST', credentials: 'same-origin',
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

  function mediaBasename(itemPath) {
    var parts = String(itemPath || '').split('/');
    return parts[parts.length - 1] || '';
  }

  function mediaPreviewUrl(item) {
    var base = mediaBasename(item.path);
    if (!base) return null;
    return API_BASE + '/autoposts/media/' + encodeURIComponent(base);
  }

  function buildMediaFilesFromPost(p) {
    if (!p || !p.media || !p.media.length) return [];
    return p.media.map(function (m) {
      return {
        existing: true,
        path: m.path,
        type: m.type || 'photo',
        preview: m.type === 'video' ? null : mediaPreviewUrl(m),
      };
    });
  }

  function fileFromMediaEntry(entry) {
    if (!entry || entry.existing) return null;
    if (entry.blob) {
      return new File([entry.blob], entry.name || 'upload', {
        type: entry.type || 'application/octet-stream',
      });
    }
    if (entry.file) return entry.file;
    return null;
  }

  function existingMediaPayload(files) {
    return files
      .filter(function (m) { return m.existing && m.path; })
      .map(function (m) { return { type: m.type || 'photo', path: m.path }; });
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
    var m = { active: 'Активен', sent: 'Отправлен', paused: 'Пауза', failed: 'Ошибка', draft: 'Черновик' };
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
    var sch = state.scheduler || {};
    var failed = (state.posts || []).filter(function (p) { return p.status === 'failed'; }).length;
    var overdue = (state.posts || []).filter(isOverdue).length;
    return '<div class="ap-metrics">' +
      '<div class="ap-metric"><div class="label">В очереди</div><div class="value">' + (s.scheduledCount || 0) + '</div></div>' +
      '<div class="ap-metric"><div class="label">Активных серий</div><div class="value">' + (s.activeSeries || 0) + '</div></div>' +
      '<div class="ap-metric"><div class="label">Успешных отправок</div><div class="value">' + (s.successRate != null ? s.successRate + '%' : '—') + '</div></div>' +
      '<div class="ap-metric' + (failed || overdue || sch.running === false ? ' ap-metric--warn' : '') + '"><div class="label">Планировщик</div><div class="value">' +
      (sch.running === false ? 'стоп' : (failed ? failed + ' ошиб.' : (overdue ? overdue + ' ждут' : 'OK'))) +
      '</div></div>' +
      '</div>';
  }

  function renderSchedulerBar() {
    var sch = state.scheduler || {};
    var running = sch.running !== false;
    var failed = (state.posts || []).filter(function (p) { return p.status === 'failed'; });
    var overdue = (state.posts || []).filter(isOverdue);
    var html = '<div class="ap-health ' + (running && !failed.length && !overdue.length ? 'ok' : 'warn') + '">';
    html += '<span class="ap-health-dot"></span>';
    html += running
      ? 'Планировщик работает · проверка каждые ' + Math.round((sch.tickMs || 15000) / 1000) + ' с'
      : 'Планировщик не запущен — посты не уйдут, пока не перезапустите бота';
    if (sch.lastTickAt) html += ' · последний проход ' + esc(fmtTime(sch.lastTickAt));
    html += '</div>';
    if (failed.length) {
      html += '<div class="ap-alert ap-alert--danger"><div><strong>' + failed.length + ' публикаций с ошибкой</strong>';
      html += '<div class="text-sm">' + esc(truncate(failed[0].last_error || 'Неизвестная ошибка', 140)) + '</div></div>';
      html += '<div class="ap-alert-actions">';
      html += '<button type="button" class="btn btn-ghost btn-sm" data-ap-edit="' + esc(failed[0].id) + '">Исправить</button>';
      html += '<button type="button" class="btn btn-ghost btn-sm" data-ap-now="' + esc(failed[0].id) + '">Повторить сейчас</button>';
      html += '<button type="button" class="btn btn-ghost btn-sm" data-ap-resume="' + esc(failed[0].id) + '">В очередь</button>';
      html += '</div></div>';
    }
    if (overdue.length) {
      html += '<div class="ap-alert"><div><strong>' + overdue.length + ' постов просрочены</strong>';
      html += '<div class="text-sm">Время наступило, но публикация ещё в очереди. Можно отправить вручную.</div></div>';
      html += '<button type="button" class="btn btn-ghost btn-sm" data-ap-now="' + esc(overdue[0].id) + '">Отправить ближайший</button></div>';
    }
    return html;
  }

  function renderUpcomingList() {
    var upcoming = state.posts.filter(function (p) {
      return p.status === 'active' || p.status === 'draft';
    }).sort(function (a, b) {
      return Date.parse(a.scheduled_at) - Date.parse(b.scheduled_at);
    }).slice(0, 24);
    if (!upcoming.length) {
      return '<div class="ap-empty"><i data-lucide="calendar-off"></i><h4>Очередь пуста</h4>' +
        '<p>Запланируйте разовую публикацию, серию по дням или интервал</p>' +
        '<button type="button" class="ap-btn-primary" style="width:auto;display:inline-block" data-ap-new-post>Создать пост</button></div>';
    }
    var html = '';
    var lastDay = '';
    upcoming.forEach(function (p) {
      var parts = partsInZone(p.scheduled_at, p.timezone || AP_DEFAULT_TZ);
      if (parts && parts.date !== lastDay) {
        lastDay = parts.date;
        var pretty = isToday(p.scheduled_at) ? 'Сегодня' : parts.date;
        html += '<div class="ap-day-label">' + esc(pretty) + '</div>';
      }
      var ci = state.channels.findIndex(function (c) { return String(c.id) === String(p.target_channel_id); });
      var color = channelColor(p.target_channel_id, ci);
      html += '<div class="ap-upcoming-item' + (isOverdue(p) ? ' overdue' : '') + (p.status === 'draft' ? ' draft' : '') + '">';
      html += '<span class="ap-upcoming-time">' + esc(fmtTime(p.scheduled_at)) + '</span>';
      html += '<span class="ap-upcoming-stripe" style="background:' + color + '"></span>';
      html += '<div class="ap-upcoming-main"><span class="ap-upcoming-text" title="' + esc(p.text) + '">' + esc(truncate(p.text || '—', 70)) + '</span>';
      html += '<div class="ap-upcoming-meta">' + renderPostTagsHtml(p.tags, false);
      html += '<span class="ap-upcoming-channel">' + esc(postChannelName(p)) + ' · ' + esc(platformLabel(p.platform || 'telegram')) + '</span></div></div>';
      html += '<div class="ap-upcoming-actions">' + postActionButtons(p, true) + '</div>';
      html += '</div>';
      if (p.last_error && p.status !== 'sent') {
        html += '<div class="ap-upcoming-error">' + esc(truncate(p.last_error, 160)) + '</div>';
      }
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
      return '<div class="ap-empty"><i data-lucide="repeat"></i><h4>Нет серий</h4><p>Ежедневно, по дням недели или каждые N часов</p></div>';
    }
    var html = '<div class="ap-table-wrap"><table class="ap-table"><thead><tr>' +
      '<th>Название</th><th>Канал</th><th>Дни</th><th>Расписание</th><th>Следующий слот</th><th>Статус</th><th>Действия</th></tr></thead><tbody>';
    series.forEach(function (p) {
      var days = p.interval_hours
        ? 'интервал'
        : ((p.weekdays || []).length >= 7 ? 'ежедневно' : (p.weekdays || []).map(function (d) { return WEEKDAY_LABELS[d]; }).join(', '));
      html += '<tr>';
      html += '<td>' + esc(truncate(p.text || 'Без названия', 40)) + '</td>';
      html += '<td>' + esc(postChannelName(p)) + '</td>';
      html += '<td>' + esc(days || '—') + '</td>';
      html += '<td class="text-sm">' + esc(conditionSummary(p)) + '</td>';
      html += '<td class="mono text-sm">' + (p.status === 'active' ? esc(fmtDateTimeTz(p.scheduled_at, p.timezone)) : '—') + '</td>';
      html += '<td><span class="ap-status-dot ' + statusDotClass(p.status) + '"></span>' + esc(statusLabel(p.status));
      if (p.last_error && p.status === 'failed') {
        html += '<div class="ap-error-hint" title="' + esc(p.last_error) + '">' + esc(truncate(p.last_error, 48)) + '</div>';
      }
      html += '</td>';
      html += '<td class="ap-actions">' + postActionButtons(p, true) + '</td></tr>';
    });
    html += '</tbody></table></div>';
    return html;
  }

  function renderSchedulePage() {
    return renderMetricsRow(state.stats) +
      renderSchedulerBar() +
      '<div class="ap-grid-2">' +
      '<div class="ap-card"><h3>Очередь публикаций</h3>' + renderUpcomingList() + '</div>' +
      '<div class="ap-card"><h3>Быстрый постинг</h3>' + renderQuickForm() + '</div>' +
      '</div>' +
      '<div class="ap-card"><h3>Серии</h3>' + renderSeriesTable() + '</div>';
  }

  function renderPostsFilters() {
    var chOpts = '<option value="">Все каналы</option>' + state.channels.map(function (c) {
      return '<option value="' + esc(String(c.id)) + '"' + (state.filters.channelId === String(c.id) ? ' selected' : '') + '>' + esc(channelLabel(c)) + '</option>';
    }).join('');
    var tagOpts = collectAllTagsFromPosts(state.posts).map(function (t) {
      return '<option value="' + esc(t.name) + '"' + (state.filters.tag === t.name ? ' selected' : '') + '>' + esc(t.name) + '</option>';
    }).join('');
    return '<div class="ap-filters">' +
      '<input type="search" class="input search" id="apFilterSearch" placeholder="Поиск по тексту или тегу…" value="' + esc(state.filters.search) + '"/>' +
      '<select class="select" id="apFilterChannel">' + chOpts + '</select>' +
      '<select class="select" id="apFilterStatus">' +
      '<option value="">Все статусы</option>' +
      '<option value="active"' + (state.filters.status === 'active' ? ' selected' : '') + '>Активен</option>' +
      '<option value="paused"' + (state.filters.status === 'paused' ? ' selected' : '') + '>Пауза</option>' +
      '<option value="sent"' + (state.filters.status === 'sent' ? ' selected' : '') + '>Отправлен</option>' +
      '<option value="failed"' + (state.filters.status === 'failed' ? ' selected' : '') + '>Ошибка</option>' +
      '<option value="draft"' + (state.filters.status === 'draft' ? ' selected' : '') + '>Черновик</option>' +
      '</select>' +
      '<select class="select" id="apFilterType">' +
      '<option value="">Все типы</option>' +
      '<option value="once"' + (state.filters.scheduleType === 'once' ? ' selected' : '') + '>Разово</option>' +
      '<option value="recurring"' + (state.filters.scheduleType === 'recurring' ? ' selected' : '') + '>Серия</option>' +
      '</select>' +
      '<select class="select" id="apFilterTag"><option value="">Все теги</option>' + tagOpts + '</select>' +
      '<input type="date" class="input" id="apFilterFrom" value="' + esc(state.filters.from) + '" title="С даты"/>' +
      '<input type="date" class="input" id="apFilterTo" value="' + esc(state.filters.to) + '" title="По дату"/>' +
      '</div>';
  }

  function getFilteredPosts() {
    var list = state.posts.slice();
    var f = state.filters;
    if (f.search) {
      var q = f.search.toLowerCase();
      list = list.filter(function (p) {
        var inText = (p.text || '').toLowerCase().includes(q);
        var inTags = normalizeTagList(p.tags).some(function (t) { return t.name.toLowerCase().includes(q); });
        return inText || inTags;
      });
    }
    if (f.tag) {
      var tagQ = f.tag.toLowerCase();
      list = list.filter(function (p) {
        return normalizeTagList(p.tags).some(function (t) { return t.name.toLowerCase() === tagQ; });
      });
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
      '<th>Платформа</th><th>Текст</th><th>Теги</th><th>Канал</th><th>Дата и время</th><th>Тип</th><th>Статус</th><th>Действия</th></tr></thead><tbody>';
    page.forEach(function (p) {
      var ci = state.channels.findIndex(function (c) { return String(c.id) === String(p.target_channel_id); });
      var color = channelColor(p.target_channel_id, ci);
      var typeBadge = p.schedule_type === 'recurring' ? 'ap-badge-series' : 'ap-badge-once';
      var typeLabel = p.schedule_type === 'recurring' ? 'Серия' : 'Разово';
      html += '<tr>';
      html += '<td><span class="ap-platform-tag ap-platform-' + esc(p.platform || 'telegram') + '">' + esc(platformLabel(p.platform || 'telegram')) + '</span></td>';
      html += '<td style="max-width:220px" title="' + esc(p.text) + '">' + esc(truncate(p.text || '—', 50)) + '</td>';
      html += '<td style="min-width:120px">' + renderPostTagsHtml(p.tags, true) + '</td>';
      html += '<td><span class="ap-channel-dot" style="background:' + color + ';display:inline-block;vertical-align:middle"></span> ' + esc(postChannelName(p)) + '</td>';
      html += '<td class="mono text-sm">' + esc(fmtDateTimeTz(p.scheduled_at, p.timezone));
      if (p.last_error && p.status === 'failed') {
        html += '<div class="ap-error-hint" title="' + esc(p.last_error) + '">' + esc(truncate(p.last_error, 40)) + '</div>';
      }
      html += '</td>';
      html += '<td><span class="ap-badge ' + typeBadge + '">' + typeLabel + '</span></td>';
      html += '<td><span class="ap-status-dot ' + statusDotClass(p.status) + '"></span>' + esc(statusLabel(p.status)) + '</td>';
      html += '<td class="ap-actions">' + postActionButtons(p, true) + '</td></tr>';
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
    if (p.interval_hours) {
      schedType = 'interval';
    } else if (p.schedule_type === 'recurring') {
      var wds = p.weekdays || [];
      schedType = wds.length >= 7 ? 'daily' : 'weekly';
    }
    var onceDate = today;
    var onceTime = '12:00';
    var tz = p.timezone || AP_DEFAULT_TZ;
    if (p.scheduled_at && p.schedule_type !== 'recurring') {
      var localParts = partsInZone(p.scheduled_at, tz);
      if (localParts) {
        onceDate = localParts.date;
        onceTime = localParts.time;
      }
    }
    var hoursRange = splitHoursRange(condValue(p.conditions, 'hours_range'));

    var backdrop = document.createElement('div');
    backdrop.className = 'ap-modal-backdrop';
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');

    var modal = document.createElement('div');
    modal.className = 'ap-modal';
    modal.innerHTML =
      '<div class="ap-modal-header"><h2>' + (editPost && editPost.id ? 'Редактировать пост' : 'Новый пост') + '</h2>' +
      '<button type="button" class="ap-modal-close" data-ap-modal-close><i data-lucide="x"></i></button></div>' +
      '<div class="ap-modal-split">' +
      '<div class="ap-modal-editor">' +
      '<div id="apModalStatus" class="ap-modal-status hidden" role="alert"></div>' +
      '<div class="ap-modal-body" id="apModalBody"></div>' +
      '</div>' +
      '<aside class="ap-modal-preview-pane" aria-label="Предпросмотр">' +
      '<div class="ap-tg-phone">' +
      '<div class="ap-tg-channel-header">' +
      '<div class="ap-tg-channel-avatar" id="apPreviewAvatar">T</div>' +
      '<div class="ap-tg-channel-meta">' +
      '<div class="ap-tg-channel-name" id="apPreviewChannelName">Канал</div>' +
      '<div class="ap-tg-channel-sub" id="apPreviewChannelSub">предпросмотр</div>' +
      '</div></div>' +
      '<div class="ap-tg-channel-feed">' +
      '<div class="ap-tg-post" id="apModalPreview"></div>' +
      '</div></div>' +
      '<div class="ap-modal-preview-caption" id="apModalPreviewLabel">Telegram</div>' +
      '</aside></div>' +
      '<div class="ap-modal-footer">' +
      '<span class="ap-modal-build">' + esc(AP_UI_BUILD) + '</span>' +
      '<div class="ap-modal-footer-actions">' +
      '<button type="button" class="btn btn-ghost" data-ap-modal-close>Отмена</button>' +
      '<button type="button" class="btn btn-ghost" data-ap-save-draft>Черновик</button>' +
      '<button type="button" class="btn btn-ghost" data-ap-publish-now>Опубликовать сейчас</button>' +
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
      dailyTimes: (p.daily_times && p.daily_times.length)
        ? p.daily_times.slice()
        : (p.recurring_time ? [p.recurring_time] : ['09:00']),
      weekdays: p.weekdays && p.weekdays.length ? p.weekdays.slice() : [1, 2, 3, 4, 5],
      startDate: p.start_date || '',
      endDate: p.end_date || '',
      timezone: tz,
      intervalHours: p.interval_hours || 6,
      repeatLimit: p.repeat_limit || '',
      hoursFrom: hoursRange.from || '',
      hoursTo: hoursRange.to || '',
      minIntervalHours: condValue(p.conditions, 'min_interval_hours') || '',
      maxPostsPerDay: condValue(p.conditions, 'max_posts_per_day') || '',
      mediaFiles: buildMediaFilesFromPost(p),
      inlineRows: inlineRowsFromPost(p),
      tags: normalizeTagList(p.tags || []),
      tagDraftColor: AP_TAG_COLORS[0],
      onFailure: p.on_failure || 'skip',
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
      } else if (st === 'interval') {
        var intEl = qs('#apModalInterval', body);
        if (intEl) modalState.intervalHours = Number(intEl.value) || 6;
        var iStart = qs('#apModalIStart', body);
        var iEnd = qs('#apModalIEnd', body);
        if (iStart) modalState.startDate = iStart.value;
        if (iEnd) modalState.endDate = iEnd.value;
      }
      snapshotInlineRowsFromDom(body);
      var onFail = qs('#apOnFailure', body);
      if (onFail) modalState.onFailure = onFail.value;
      var tzEl = qs('#apTimezone', body);
      if (tzEl) modalState.timezone = tzEl.value || AP_DEFAULT_TZ;
      var limitEl = qs('#apRepeatLimit', body);
      if (limitEl) modalState.repeatLimit = limitEl.value;
      var hf = qs('#apHoursFrom', body);
      var ht = qs('#apHoursTo', body);
      if (hf) modalState.hoursFrom = hf.value;
      if (ht) modalState.hoursTo = ht.value;
      var mi = qs('#apMinInterval', body);
      if (mi) modalState.minIntervalHours = mi.value;
      var md = qs('#apMaxDay', body);
      if (md) modalState.maxPostsPerDay = md.value;
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

    function updatePreviewChannelMeta() {
      var nameEl = qs('#apPreviewChannelName', modal);
      var subEl = qs('#apPreviewChannelSub', modal);
      var avatarEl = qs('#apPreviewAvatar', modal);
      var phone = qs('.ap-tg-phone', modal);
      var firstId = modalState.channels[0];
      var ch = firstId ? state.channels.find(function (c) { return String(c.id) === firstId; }) : null;
      var label = ch ? channelLabel(ch) : 'Канал';
      if (nameEl) nameEl.textContent = label;
      if (subEl) {
        subEl.textContent = modalState.platform === 'max' ? 'MAX · предпросмотр' : 'Telegram · предпросмотр';
      }
      if (avatarEl) {
        var letter = (label.replace(/^@/, '').charAt(0) || 'C').toUpperCase();
        avatarEl.textContent = letter;
        if (ch) {
          var ci = state.channels.findIndex(function (c) { return String(c.id) === firstId; });
          avatarEl.style.background = channelColor(firstId, ci);
        }
      }
      if (phone) {
        phone.classList.toggle('ap-tg-phone--max', modalState.platform === 'max');
      }
    }

    function snapshotInlineRowsFromDom(body) {
      var container = qs('#apInlineRows', body);
      if (!container) return;
      var next = [];
      qsa('.ap-inline-row', container).forEach(function (rowEl) {
        var layoutBtn = qs('[data-inline-layout].active', rowEl);
        var layout = layoutBtn && layoutBtn.getAttribute('data-inline-layout') === '2' ? '2' : '1';
        var buttons = [];
        qsa('[data-inline-btn]', rowEl).forEach(function (cell, idx) {
          if (layout === '1' && idx > 0) return;
          var textEl = qs('[data-inline-field="text"]', cell);
          var urlEl = qs('[data-inline-field="url"]', cell);
          buttons.push({
            text: textEl ? textEl.value : '',
            url: urlEl ? urlEl.value : '',
          });
        });
        if (layout === '2' && buttons.length < 2) {
          buttons.push({ text: '', url: '' });
        }
        next.push({ layout: layout, buttons: buttons });
      });
      modalState.inlineRows = next;
    }

    function renderInlineRowsEditor(body) {
      var wrap = qs('#apInlineRows', body);
      if (!wrap) return;
      wrap.innerHTML = buildInlineRowsEditorHtml(modalState.inlineRows);
    }

    function renderTagEditor(body) {
      var wrap = qs('#apTagEditor', body);
      if (!wrap) return;
      wrap.innerHTML = buildTagEditorHtml(modalState.tags, modalState.tagDraftColor);
    }

    function addTagFromDraft(body) {
      var inp = qs('#apTagInput', body);
      var name = inp ? inp.value.trim().replace(/\s+/g, ' ') : '';
      if (!name) {
        showModalStatus('Введите название тега', 'error');
        return;
      }
      if (modalState.tags.length >= 10) {
        showModalStatus('Не более 10 тегов на пост', 'error');
        return;
      }
      var exists = modalState.tags.some(function (t) { return t.name.toLowerCase() === name.toLowerCase(); });
      if (exists) {
        showModalStatus('Такой тег уже добавлен', 'error');
        return;
      }
      modalState.tags = normalizeTagList(modalState.tags.concat([{
        name: name.slice(0, 32),
        color: modalState.tagDraftColor || AP_TAG_COLORS[0],
      }]));
      if (inp) inp.value = '';
      hideModalStatus();
      renderTagEditor(body);
      wireTagEditor(body);
    }

    function wireTagEditor(body) {
      var addBtn = qs('#apTagAdd', body);
      if (addBtn) {
        addBtn.addEventListener('click', function () { addTagFromDraft(body); });
      }
      var inp = qs('#apTagInput', body);
      if (inp) {
        inp.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') {
            e.preventDefault();
            addTagFromDraft(body);
          }
        });
      }
      qsa('[data-rm-tag]', body).forEach(function (btn) {
        btn.addEventListener('click', function () {
          var idx = Number(btn.getAttribute('data-rm-tag'));
          modalState.tags.splice(idx, 1);
          modalState.tags = normalizeTagList(modalState.tags);
          renderTagEditor(body);
          wireTagEditor(body);
        });
      });
      qsa('[data-tag-color]', body).forEach(function (btn) {
        btn.addEventListener('click', function () {
          modalState.tagDraftColor = btn.getAttribute('data-tag-color') || AP_TAG_COLORS[0];
          qsa('[data-tag-color]', body).forEach(function (b) {
            b.classList.toggle('active', b === btn);
          });
        });
      });
    }

    function wireInlineRowsEditor(body) {
      var addBtn = qs('#apAddInlineRow', body);
      if (addBtn) {
        addBtn.addEventListener('click', function () {
          snapshotFromDom();
          if (modalState.inlineRows.length >= 8) {
            showModalStatus('Не более 8 рядов кнопок', 'error');
            return;
          }
          modalState.inlineRows.push({ layout: '1', buttons: [{ text: '', url: '' }] });
          renderInlineRowsEditor(body);
          wireInlineRowsEditor(body);
          updateModalPreview();
        });
      }
      qsa('[data-rm-inline-row]', body).forEach(function (btn) {
        btn.addEventListener('click', function () {
          snapshotFromDom();
          var idx = Number(btn.getAttribute('data-rm-inline-row'));
          modalState.inlineRows.splice(idx, 1);
          renderInlineRowsEditor(body);
          wireInlineRowsEditor(body);
          updateModalPreview();
        });
      });
      qsa('[data-inline-layout]', body).forEach(function (btn) {
        btn.addEventListener('click', function () {
          snapshotFromDom();
          var rowEl = btn.closest('.ap-inline-row');
          if (!rowEl) return;
          var idx = Number(rowEl.getAttribute('data-inline-row'));
          var row = modalState.inlineRows[idx];
          if (!row) return;
          var nextLayout = btn.getAttribute('data-inline-layout') === '2' ? '2' : '1';
          if (row.layout === nextLayout) return;
          row.layout = nextLayout;
          if (nextLayout === '2' && row.buttons.length < 2) {
            row.buttons.push({ text: '', url: '' });
          }
          renderInlineRowsEditor(body);
          wireInlineRowsEditor(body);
          updateModalPreview();
        });
      });
      qsa('#apInlineRows [data-inline-field]', body).forEach(function (el) {
        el.addEventListener('input', function () {
          snapshotInlineRowsFromDom(body);
          updateModalPreview();
        });
      });
    }

    function updateModalPreview() {
      var wrap = qs('#apModalPreview', modal);
      if (!wrap) return;
      var text = (modalState.text || '').trim();
      var keyboard = serializeInlineKeyboard(modalState.inlineRows);
      var media = modalState.mediaFiles || [];
      var html = '<div class="ap-tg-post-card">';

      if (media.length) {
        if (media.length === 1) {
          var single = media[0];
          if (single.preview) {
            html += '<div class="ap-tg-post-media ap-tg-post-media--single"><img src="' + single.preview + '" alt=""/></div>';
          } else if (single.type === 'video' || (single.file && single.file.type && single.file.type.indexOf('video/') === 0)) {
            html += '<div class="ap-tg-post-media ap-tg-post-media--video"><span>▶ ' + esc((single.file && single.file.name) || single.name || 'Видео') + '</span></div>';
          } else if (single.existing && single.type === 'video') {
            html += '<div class="ap-tg-post-media ap-tg-post-media--video"><span>▶ Видео</span></div>';
          } else {
            html += '<div class="ap-tg-post-media ap-tg-post-media--file"><span>📎 ' + esc((single.file && single.file.name) || single.name || 'Файл') + '</span></div>';
          }
        } else {
          html += '<div class="ap-tg-post-media ap-tg-post-media--album">';
          media.forEach(function (m) {
            if (m.preview) {
              html += '<img src="' + m.preview + '" alt=""/>';
            } else {
              html += '<div class="ap-tg-album-ph">' + (m.type === 'video' ? '▶' : '📎') + '</div>';
            }
          });
          html += '</div>';
        }
      }

      if (text && !(window.ApTextEditor && window.ApTextEditor.isEmpty(text))) {
        var previewText = window.ApTextEditor
          ? window.ApTextEditor.previewHtml(text)
          : esc(text);
        html += '<div class="ap-tg-post-text ap-preview-formatted">' + previewText + '</div>';
      } else if (!media.length && !keyboard) {
        html += '<div class="ap-tg-post-text ap-tg-post-text--placeholder">Добавьте текст, фото или кнопку</div>';
      }

      if (keyboard && keyboard.length) {
        html += '<div class="ap-tg-post-actions">';
        keyboard.forEach(function (row) {
          html += '<div class="ap-tg-inline-row' + (row.length === 2 ? ' ap-tg-inline-row--2' : '') + '">';
          row.forEach(function (btn) {
            html += '<span class="ap-tg-inline-btn">' + esc(btn.text) + '</span>';
          });
          html += '</div>';
        });
        html += '</div>';
      } else if (modalState.inlineRows.length) {
        html += '<div class="ap-tg-post-actions"><span class="ap-tg-inline-btn ap-tg-inline-btn--warn">Заполните текст и URL кнопок</span></div>';
      }

      html += '<div class="ap-tg-post-footer"><span class="ap-tg-views">👁 <span>0</span></span></div>';
      html += '</div>';

      wrap.innerHTML = html;
      qsa('.ap-spoiler', wrap).forEach(function (el) {
        el.addEventListener('click', function () { el.classList.toggle('revealed'); });
      });
      updatePreviewChannelMeta();
    }

    function updatePreviewLabel() {
      var lbl = qs('#apModalPreviewLabel', modal);
      if (lbl) lbl.textContent = 'Как в ' + platformLabel(modalState.platform);
      updatePreviewChannelMeta();
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
        '<section class="ap-form-section" id="apSecTags"><h3>Теги</h3>' +
        '<p class="text-sm muted ap-tag-hint">До 10 тегов · для группировки и фильтрации постов</p>' +
        '<div id="apTagEditor">' + buildTagEditorHtml(modalState.tags, modalState.tagDraftColor) + '</div></section>' +
        '<section class="ap-form-section" id="apSecText"><h3>Текст</h3>' +
        '<div id="apTextEditorMount" class="ap-text-editor-mount"></div>' +
        '<textarea class="textarea hidden" id="apModalText" rows="4">' + esc(modalState.text) + '</textarea>' +
        '<div class="ap-char-count"><span id="apCharCount">0</span> символов · <span class="muted">Telegram & MAX HTML</span></div></section>' +
        '<section class="ap-form-section" id="apSecSchedule"><h3>Расписание</h3>' +
        '<div class="ap-schedule-types ap-schedule-types-4" id="apModalSchedTypes">' +
        '<button type="button" class="ap-schedule-type' + (st === 'once' ? ' active' : '') + '" data-mst="once">Разово</button>' +
        '<button type="button" class="ap-schedule-type' + (st === 'daily' ? ' active' : '') + '" data-mst="daily">Ежедневно</button>' +
        '<button type="button" class="ap-schedule-type' + (st === 'weekly' ? ' active' : '') + '" data-mst="weekly">По дням</button>' +
        '<button type="button" class="ap-schedule-type' + (st === 'interval' ? ' active' : '') + '" data-mst="interval">Интервал</button>' +
        '</div>' +
        '<div id="apModalOnce" class="ap-schedule-panel' + (st !== 'once' ? ' hidden' : '') + '">' +
        '<div class="form-row"><div class="form-group"><label>Дата</label><input type="date" class="input" id="apModalDate" value="' + esc(modalState.onceDate) + '"/></div>' +
        '<div class="form-group"><label>Время</label><input type="time" class="input" id="apModalTime" value="' + esc(modalState.onceTime) + '"/></div></div></div>' +
        '<div id="apModalDaily" class="ap-schedule-panel' + (st !== 'daily' ? ' hidden' : '') + '">' +
        '<label>Времена публикации</label><div class="ap-time-chips" id="apDailyChips"></div>' +
        '<div class="ap-time-add"><input type="time" class="input" id="apNewDailyTime" value="14:00"/><button type="button" class="btn btn-ghost btn-sm" id="apAddDailyTime">+ Добавить время</button></div>' +
        '<div class="form-row"><div class="form-group"><label>Дата начала</label><input type="date" class="input" id="apModalStart" value="' + esc(modalState.startDate) + '"/></div>' +
        '<div class="form-group"><label>Дата окончания</label><input type="date" class="input" id="apModalEnd" value="' + esc(modalState.endDate) + '"/></div></div></div>' +
        '<div id="apModalWeekly" class="ap-schedule-panel' + (st !== 'weekly' ? ' hidden' : '') + '">' +
        '<label>Дни недели</label><div class="ap-weekdays" id="apModalWd">' + buildWeekdayHtml('apmodal', modalState.weekdays) + '</div>' +
        '<div class="form-group"><label>Время</label><input type="time" class="input" id="apModalWeeklyTime" value="' + esc(modalState.dailyTimes[0] || '09:00') + '"/></div>' +
        '<div class="form-row"><div class="form-group"><label>Дата начала</label><input type="date" class="input" id="apModalWStart" value="' + esc(modalState.startDate) + '"/></div>' +
        '<div class="form-group"><label>Дата окончания</label><input type="date" class="input" id="apModalWEnd" value="' + esc(modalState.endDate) + '"/></div></div></div>' +
        '<div id="apModalInterval" class="ap-schedule-panel' + (st !== 'interval' ? ' hidden' : '') + '">' +
        '<div class="form-group"><label>Повторять каждые (часы)</label><input type="number" class="input" id="apModalInterval" min="1" max="720" step="1" value="' + esc(String(modalState.intervalHours || 6)) + '"/></div>' +
        '<div class="form-row"><div class="form-group"><label>Дата начала</label><input type="date" class="input" id="apModalIStart" value="' + esc(modalState.startDate) + '"/></div>' +
        '<div class="form-group"><label>Дата окончания</label><input type="date" class="input" id="apModalIEnd" value="' + esc(modalState.endDate) + '"/></div></div></div>' +
        '<details class="ap-advanced"' + (modalState.hoursFrom || modalState.repeatLimit || modalState.minIntervalHours ? ' open' : '') + '>' +
        '<summary>Гибкие условия и часовой пояс</summary>' +
        '<div class="form-group"><label>Часовой пояс</label><select class="select" id="apTimezone">' + tzOptionsHtml(modalState.timezone) + '</select></div>' +
        '<div class="form-row"><div class="form-group"><label>Публиковать с</label><input type="time" class="input" id="apHoursFrom" value="' + esc(modalState.hoursFrom) + '"/></div>' +
        '<div class="form-group"><label>до</label><input type="time" class="input" id="apHoursTo" value="' + esc(modalState.hoursTo) + '"/></div></div>' +
        '<div class="form-row"><div class="form-group"><label>Мин. пауза между постами (ч)</label><input type="number" class="input" id="apMinInterval" min="0" step="0.5" placeholder="нет" value="' + esc(String(modalState.minIntervalHours || '')) + '"/></div>' +
        '<div class="form-group"><label>Макс. постов в канал за день</label><input type="number" class="input" id="apMaxDay" min="1" placeholder="без лимита" value="' + esc(String(modalState.maxPostsPerDay || '')) + '"/></div></div>' +
        '<div class="form-row"><div class="form-group"><label>Лимит повторов серии</label><input type="number" class="input" id="apRepeatLimit" min="1" placeholder="без лимита" value="' + esc(String(modalState.repeatLimit || '')) + '"/></div>' +
        '<div class="form-group"><label>При ошибке отправки</label><select class="select" id="apOnFailure">' +
        '<option value="skip"' + (modalState.onFailure === 'skip' ? ' selected' : '') + '>Пропустить слот и продолжить</option>' +
        '<option value="retry_15m"' + (modalState.onFailure === 'retry_15m' ? ' selected' : '') + '>Повторить через 15 минут</option>' +
        '<option value="stop_series"' + (modalState.onFailure === 'stop_series' ? ' selected' : '') + '>Остановить серию</option>' +
        '<option value="notify"' + (modalState.onFailure === 'notify' ? ' selected' : '') + '>Остановить и показать ошибку</option>' +
        '</select></div></div>' +
        '</details>' +
        '</section>' +
        '<section class="ap-form-section" id="apSecMedia"><h3>Медиа и кнопка</h3>' +
        '<div class="ap-dropzone" id="apDropzone">Нажмите или перетащите фото/видео<br><span class="text-sm muted">До 10 файлов</span></div>' +
        '<input type="file" id="apModalMedia" multiple accept="image/*,video/*" class="hidden"/>' +
        '<div class="ap-media-grid" id="apMediaGrid"></div>' +
        '<div class="ap-inline-section">' +
        '<div class="ap-inline-section-head">' +
        '<label>Инлайн-кнопки</label>' +
        '<button type="button" class="btn btn-ghost btn-sm" id="apAddInlineRow">+ Добавить ряд</button>' +
        '</div>' +
        '<p class="text-sm muted ap-inline-hint">До 8 рядов · 1 или 2 кнопки в ряду · URL с https://</p>' +
        '<div id="apInlineRows" class="ap-inline-rows">' + buildInlineRowsEditorHtml(modalState.inlineRows) + '</div>' +
        '</div></section>';

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
          var panelId = { once: 'apModalOnce', daily: 'apModalDaily', weekly: 'apModalWeekly', interval: 'apModalInterval' }[modalState.scheduleType];
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
          var inp = qs('#apNewDailyTime', body);
          var t = inp && inp.value;
          if (t && /^\d{1,2}:\d{2}$/.test(t)) {
            if (modalState.dailyTimes.indexOf(t) < 0) modalState.dailyTimes.push(t);
            modalState.dailyTimes.sort();
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

      qsa('#apModalDate, #apModalTime, #apModalStart, #apModalEnd, #apModalWeeklyTime, #apModalWStart, #apModalWEnd, #apModalInterval, #apModalIStart, #apModalIEnd, #apTimezone, #apOnFailure, #apHoursFrom, #apHoursTo, #apMinInterval, #apMaxDay, #apRepeatLimit', body).forEach(function (el) {
        el.addEventListener('change', snapshotFromDom);
      });

      var dz = qs('#apDropzone', body);
      var fileInput = qs('#apModalMedia', body);
      function renderMediaGrid() {
        var grid = qs('#apMediaGrid', body);
        if (!grid) return;
        grid.innerHTML = modalState.mediaFiles.map(function (f, i) {
          var url = f.preview || '';
          var label = f.type === 'video' ? '🎬' : (url ? '' : '📎');
          return '<div class="ap-media-thumb">' + (url ? '<img src="' + url + '" alt=""/>' : label) +
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
          var blob = f;
          try {
            if (typeof f.slice === 'function') {
              blob = f.slice(0, f.size, f.type || 'application/octet-stream');
            }
          } catch (_sliceErr) {
            blob = f;
          }
          modalState.mediaFiles.push({
            blob: blob,
            name: f.name || ('upload-' + Date.now() + '.jpg'),
            type: f.type || 'application/octet-stream',
            preview: f.type && f.type.indexOf('image/') === 0 ? URL.createObjectURL(blob) : null,
          });
        }
        if (fileInput) fileInput.value = '';
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
      wireTagEditor(body);
      wireInlineRowsEditor(body);

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

    function appendScheduleFields(fd, asDraft) {
      var st = modalState.scheduleType;
      fd.append('timezone', modalState.timezone || AP_DEFAULT_TZ);
      fd.append('status', asDraft ? 'draft' : 'active');
      fd.append('on_failure', modalState.onFailure || 'skip');
      if (modalState.repeatLimit) fd.append('repeat_limit', String(modalState.repeatLimit));
      if (modalState.hoursFrom && modalState.hoursTo) {
        fd.append('hours_from', modalState.hoursFrom);
        fd.append('hours_to', modalState.hoursTo);
      }
      if (modalState.minIntervalHours) fd.append('min_interval_hours', String(modalState.minIntervalHours));
      if (modalState.maxPostsPerDay) fd.append('max_posts_per_day', String(modalState.maxPostsPerDay));
      if (st === 'once') {
        fd.append('schedule_type', 'once');
        fd.append('scheduled_local', modalState.onceDate + 'T' + (modalState.onceTime || '12:00'));
        fd.append('scheduled_at', new Date(modalState.onceDate + 'T' + (modalState.onceTime || '12:00')).toISOString());
      } else if (st === 'interval') {
        fd.append('schedule_type', 'recurring');
        fd.append('interval_hours', String(modalState.intervalHours || 6));
        fd.append('weekdays', JSON.stringify([0, 1, 2, 3, 4, 5, 6]));
        fd.append('recurring_time', modalState.dailyTimes[0] || '09:00');
        fd.append('scheduled_at', new Date().toISOString());
        if (modalState.startDate) fd.append('start_date', modalState.startDate);
        if (modalState.endDate) fd.append('end_date', modalState.endDate);
      } else {
        fd.append('schedule_type', 'recurring');
        var times = st === 'weekly'
          ? [modalState.dailyTimes[0] || '09:00']
          : (modalState.dailyTimes.length ? modalState.dailyTimes.slice() : ['09:00']);
        var weekdays = st === 'weekly' ? modalState.weekdays.slice() : [0, 1, 2, 3, 4, 5, 6];
        fd.append('recurring_time', times[0]);
        fd.append('daily_times', JSON.stringify(times));
        fd.append('weekdays', JSON.stringify(weekdays));
        fd.append('scheduled_at', new Date().toISOString());
        if (modalState.startDate) fd.append('start_date', modalState.startDate);
        if (modalState.endDate) fd.append('end_date', modalState.endDate);
      }
    }

    function submitPost(asDraft, publishNow) {
      snapshotFromDom();
      hideModalStatus();
      var text = (modalState.text || '').trim();
      var textEmpty = window.ApTextEditor ? window.ApTextEditor.isEmpty(text) : !text;
      var submitBtn = qs('[data-ap-submit-post]', modal);
      var draftBtn = qs('[data-ap-save-draft]', modal);
      var nowBtn = qs('[data-ap-publish-now]', modal);
      if (!modalState.channels.length) {
        showModalStatus('Выберите хотя бы один канал', 'error');
        var sec = qs('#apSecChannels', modal);
        if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      var keyboard = serializeInlineKeyboard(modalState.inlineRows);
      var mediaCount = modalState.mediaFiles.length;
      if (textEmpty && !mediaCount) {
        showModalStatus('Введите текст или добавьте фото/видео', 'error');
        var secText = qs('#apSecText', modal);
        if (secText) secText.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      if (mediaCount > 1 && keyboard && modalState.platform === 'telegram') {
        showModalStatus('Инлайн-кнопки недоступны для альбома из нескольких файлов в Telegram', 'error');
        return;
      }

      var st = modalState.scheduleType;
      if (!publishNow && st === 'once' && !modalState.onceDate) {
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
      if (nowBtn) nowBtn.disabled = true;
      var promises = modalState.channels.map(function (channelId) {
        var fd = new FormData();
        fd.append('target_channel_id', channelId);
        fd.append('platform', modalState.platform);
        var ch = state.channels.find(function (c) { return String(c.id) === channelId; });
        if (ch) fd.append('channel_title', channelLabel(ch));
        fd.append('text', text);
        appendScheduleFields(fd, asDraft);
        if (publishNow) {
          fd.set('status', 'draft');
          if (!state.editingId) {
            fd.set('schedule_type', 'once');
            fd.set('scheduled_at', new Date().toISOString());
          }
        }
        fd.append('inline_buttons', JSON.stringify(keyboard || []));
        fd.append('tags', JSON.stringify(normalizeTagList(modalState.tags)));
        fd.append('existing_media', JSON.stringify(existingMediaPayload(modalState.mediaFiles)));
        modalState.mediaFiles.forEach(function (m) {
          var file = fileFromMediaEntry(m);
          if (file) fd.append('media', file);
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
        .then(function (results) {
          if (!publishNow) return results;
          return Promise.all(results.map(function (r) {
            var id = r && r.post && r.post.id;
            if (!id) return r;
            return apiPostJson('/autoposts/' + encodeURIComponent(id) + '/publish-now', {});
          }));
        })
        .then(function () {
          toast(publishNow ? 'Опубликовано' : (asDraft ? 'Черновик сохранён' : 'Пост запланирован'), 'success');
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
          if (nowBtn) nowBtn.disabled = false;
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
    qs('[data-ap-submit-post]', modal).addEventListener('click', function () { submitPost(false, false); });
    qs('[data-ap-save-draft]', modal).addEventListener('click', function () { submitPost(true, false); });
    var publishNowBtn = qs('[data-ap-publish-now]', modal);
    if (publishNowBtn) {
      publishNowBtn.addEventListener('click', function () { submitPost(false, true); });
    }

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
    qsa('[data-ap-now]', root).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-ap-now');
        confirmDlg('Опубликовать сейчас?', 'Пост уйдёт в канал сразу, не дожидаясь расписания.', function () {
          apiPostJson('/autoposts/' + encodeURIComponent(id) + '/publish-now', {})
            .then(function () { toast('Опубликовано', 'success'); loadAndRender(); })
            .catch(function (e) { toast(e.message, 'error'); });
        });
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
          fd.append('timezone', AP_DEFAULT_TZ);
          fd.append('status', 'active');
          if (qType === 'once') {
            fd.append('schedule_type', 'once');
            var d = qs('#apQuickDate', root).value;
            var t = qs('#apQuickTime', root).value;
            fd.append('scheduled_local', d + 'T' + t);
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
    ['apFilterChannel', 'apFilterStatus', 'apFilterType', 'apFilterTag', 'apFilterFrom', 'apFilterTo'].forEach(function (id) {
      var el = qs('#' + id, root);
      if (!el) return;
      el.addEventListener('change', function () {
        state.filters.channelId = qs('#apFilterChannel', root) ? qs('#apFilterChannel', root).value : '';
        state.filters.status = qs('#apFilterStatus', root) ? qs('#apFilterStatus', root).value : '';
        state.filters.scheduleType = qs('#apFilterType', root) ? qs('#apFilterType', root).value : '';
        state.filters.tag = qs('#apFilterTag', root) ? qs('#apFilterTag', root).value : '';
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
      state.scheduler = results[2].scheduler || null;
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
