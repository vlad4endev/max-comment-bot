
  var dashPeriodDays = 7

  function bindDashPeriodTabs() {
    var tabs = qs('#dashPeriodTabs')
    if (!tabs || tabs.dataset.bound === '1') return
    tabs.dataset.bound = '1'
    tabs.addEventListener('click', function (e) {
      var btn = e.target.closest('.period-tab')
      if (!btn) return
      dashPeriodDays = Number(btn.getAttribute('data-days'))
      tabs.querySelectorAll('.period-tab').forEach(function (b) {
        b.classList.toggle('active', b === btn)
      })
      loadOverview()
    })
  }

  function formatDashDate(iso) {
    if (!iso) return '—'
    try {
      return new Date(iso).toLocaleString('ru-RU', {
        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
      })
    } catch (e) { return String(iso) }
  }

  function formatShortDay(dateKey) {
    if (!dateKey) return ''
    var p = dateKey.split('-')
    return p[2] + '.' + p[1]
  }

  function renderMetricBar(label, pct) {
    var v = Math.min(100, Math.max(0, Number(pct) || 0))
    return '<div class="metric-row"><span>' + esc(label) +
      '</span><div class="bar-track"><div class="bar-fill" style="width:' + v +
      '%"></div></div><span class="val">' + esc(v) + '%</span></div>'
  }

  function renderDashboard(d, activity) {
    var eff = d.effectiveness || {}
    var t = d.totals || {}
    var funnel = d.funnel || {}
    var periodLabel = d.period_days === 0 ? 'всего' : 'за период'

    var statsHtml =
      '<div class="stat-card"><div class="label">Комментарии</div><div class="value">' + esc(t.comments_in_period) +
      '</div><div class="sub">' + periodLabel + ' · всего <strong>' + esc(t.comments) + '</strong></div></div>' +
      '<div class="stat-card"><div class="label">Посты с кнопкой</div><div class="value">' + esc(t.posts_in_period) +
      '</div><div class="sub">' + periodLabel + ' · всего <strong>' + esc(t.posts) + '</strong></div></div>' +
      '<div class="stat-card"><div class="label">Уникальные авторы</div><div class="value">' + esc(t.unique_commenters_in_period) +
      '</div><div class="sub">всего <strong>' + esc(t.unique_commenters_all) + '</strong></div></div>' +
      '<div class="stat-card"><div class="label">Ответы админов</div><div class="value">' + esc(t.admin_replies_in_period) +
      '</div><div class="sub">доля <strong>' + esc(eff.reply_rate) + '%</strong></div></div>' +
      '<div class="stat-card"><div class="label">Каналы</div><div class="value">' + esc(t.channels) +
      '</div><div class="sub">активных <strong>' + esc(t.channels_active) + '</strong>' +
      (t.channels_pending > 0 ? ' · ожидают <strong>' + esc(t.channels_pending) + '</strong>' : '') + '</div></div>' +
      '<div class="stat-card"><div class="label">Подписчики бота</div><div class="value">' + esc(t.bot_subscribers) +
      '</div><div class="sub">+' + esc(t.subscribers_in_period) + ' ' + periodLabel + '</div></div>'

    var metricsHtml =
      renderMetricBar('Вовлечённость (комм./пост)', Math.min(100, (eff.engagement_rate || 0) * 25)) +
      renderMetricBar('Ответы админов', eff.reply_rate) +
      renderMetricBar('Охват каналов', eff.coverage_rate) +
      renderMetricBar('Активация подписчиков', Math.min(100, (eff.activation_rate || 0) * 2)) +
      renderMetricBar('Посты с комментариями', eff.posts_with_comments_pct)

    var funnelHtml =
      '<div class="funnel-step"><div class="num">' + esc(funnel.bot_subscribers) + '</div><div class="lbl">Подписчики бота (/start)</div></div>' +
      '<div class="funnel-step"><div class="num">' + esc(funnel.notify_opt_ins) + '</div><div class="lbl">Включили уведомления</div></div>' +
      '<div class="funnel-step"><div class="num">' + esc(funnel.unique_commenters) + '</div><div class="lbl">Оставили комментарий</div></div>' +
      '<div class="funnel-step"><div class="num">' + esc(funnel.miniapp_users) + '</div><div class="lbl">Открывали мини-приложение</div></div>'

    var series = d.timeseries || []
    var maxC = 1
    series.forEach(function (p) { if (p.comments > maxC) maxC = p.comments })
    var chartHtml = series.map(function (p) {
      var h = Math.round((p.comments / maxC) * 100)
      return '<div class="chart-bar-col" title="' + esc(p.date) + ': ' + esc(p.comments) + ' комм.">' +
        '<div class="chart-bar" style="height:' + Math.max(2, h) + '%"></div>' +
        '<span class="chart-lbl">' + esc(formatShortDay(p.date)) + '</span></div>'
    }).join('')

    var chRows = (d.channels || []).map(function (c) {
      var st = c.status === 'pending'
        ? '<span class="badge badge-pending">Ожидает</span>'
        : '<span class="badge badge-active">Активен</span>'
      var last = c.last_activity_at ? formatDashDate(c.last_activity_at) : '—'
      return '<tr><td><strong>' + esc(c.title || ('Канал ' + c.chat_id)) + '</strong></td><td>' + st + '</td><td>' +
        esc(c.comments_in_period) + '</td><td>' + esc(c.comment_count) + '</td><td>' + esc(c.engagement_rate) +
        '</td><td>' + esc(c.reply_rate) + '%</td><td>' + esc(c.unique_commenters) + '</td><td>' +
        esc(c.notify_links) + '</td><td class="muted">' + esc(last) + '</td></tr>'
    }).join('')

    var insights = (eff.insights || []).map(function (line) { return '<li>' + esc(line) + '</li>' }).join('')
    var actLabels = {
      new_subscriber: 'Новый подписчик', new_comment: 'Новый комментарий',
      new_post_button: 'Кнопка на посте', admin_reply: 'Ответ администратора', channel_added: 'Канал подключён',
    }
    var actHtml = ((activity && activity.events) || []).map(function (ev) {
      return '<div class="activity-item"><span class="activity-type">' + esc(actLabels[ev.type] || ev.type) +
        '</span> <span class="activity-time">' + esc(formatDashDate(ev.timestamp)) +
        '</span><div class="muted" style="margin-top:0.25rem;">' + esc(JSON.stringify(ev.payload)) + '</div></div>'
    }).join('')

    qs('#dashRoot').innerHTML =
      '<div class="dash-grid-top"><div class="eff-card"><div class="eff-ring" style="--pct:' + esc(eff.score) +
      '"><span class="eff-score">' + esc(eff.score) + '</span></div><p class="eff-label">Эффективность бота</p>' +
      '<span class="eff-grade ' + esc(eff.grade) + '">' + esc(eff.label) + '</span></div>' +
      '<div class="panel" style="margin:0;"><h2>Ключевые метрики</h2><div class="metric-bars">' + metricsHtml + '</div></div></div>' +
      '<div class="stats-grid">' + statsHtml + '</div><div class="funnel-grid">' + funnelHtml + '</div>' +
      '<div class="panel"><h2>Активность: комментарии по дням</h2><div class="chart-wrap">' +
      (chartHtml || '<p class="muted">Нет данных за период</p>') + '</div></div>' +
      '<div class="panel"><h2>Активность по каналам</h2><table><thead><tr><th>Канал</th><th>Статус</th>' +
      '<th>Комм. (период)</th><th>Комм. (всего)</th><th>Комм./пост</th><th>Ответы</th><th>Авторы</th>' +
      '<th>Уведомл.</th><th>Последняя активность</th></tr></thead><tbody>' +
      (chRows || '<tr><td colspan="9" class="muted">Нет подключённых каналов</td></tr>') + '</tbody></table></div>' +
      '<div class="panel"><h2>Рекомендации</h2><ul class="insights-list">' +
      (insights || '<li class="muted">Нет данных</li>') + '</ul></div>' +
      '<div class="panel"><h2>Последние события</h2>' + (actHtml || '<p class="muted">Нет событий</p>') + '</div>'

    qs('#dashRoot').innerHTML = qs('#dashRoot').innerHTML.replace(/<\/?div\b[^>]*>/g, function (tag) {
      return tag.indexOf('</') === 0 ? '</div>' : '<div'.replace('div', 'div')
    })
  }

  function loadOverview() {
    bindDashPeriodTabs()
    var root = qs('#dashRoot')
    if (root) root.innerHTML = '<p class="dash-loading">Загрузка…</p>'
    Promise.all([
      fetch(apiPath('/dashboard?days=' + dashPeriodDays), { credentials: 'same-origin' }).then(handleAuth).then(function (r) { return r.json() }),
      fetch(apiPath('/activity'), { credentials: 'same-origin' }).then(handleAuth).then(function (r) { return r.json() }),
    ]).then(function (results) {
      var d = results[0]
      qs('#dashUpdated').textContent = 'Обновлено: ' + formatDashDate(d.generated_at)
      renderDashboard(d, results[1])
    }).catch(function (err) {
      if (err && err.message === 'auth') return
      if (root) root.innerHTML = '<p class="muted">Не удалось загрузить дашборд</p>'
    })
  }
