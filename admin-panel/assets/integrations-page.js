  function renderIntegrations() {
    var main = qs('#mainContent');
    if (!main) return;
    main.innerHTML = '<motion class="dash-loading muted">Загрузка…</motion>';
    main.innerHTML = '<div class="dash-loading muted">Загрузка…</div>';

    Promise.all([
      getJsonAbs(API_INTEGRATIONS),
      getJsonAbs(API_FLOWS),
      getJsonAbs(API_INTEGRATIONS + '/meta/max'),
      getJsonAbs(API_INT_ANALYTICS),
      getJsonAbs(API_FLOWS + '/log?limit=50'),
    ])
      .then(function (bundle) {
        if (currentRoute !== 'integrations') return;
        integrationsCache = bundle[0].integrations || [];
        flowsCache = bundle[1].flows || [];
        intMaxMeta = bundle[2];
        var analytics = bundle[3];
        var logItems = bundle[4].items || [];

        var tg = integrationsCache.find(function (i) { return i.platform === 'telegram'; });
        var vk = integrationsCache.find(function (i) { return i.platform === 'vk'; });

        var html = '<div class="int-page"><motion class="int-tabs">';
        html = '<div class="int-page"><div class="int-tabs">';
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
            '<div class="integration-card connected"><div class="int-card-header"><div class="int-logo max">М</div><div class="int-info"><div class="int-name">MAX</div><motion class="int-desc">Основная платформа — подключён</div></div>';
          html = html.replace('<motion class="int-desc">', '<div class="int-desc">');
          html +=
            '<span class="int-status connected"><i data-lucide="circle-check"></i> Подключён</span></div><div class="int-meta"><span>Каналов: <strong>' +
            esc(String((intMaxMeta && intMaxMeta.channelCount) || 0)) +
            '</strong></span><span>Bot Token: <code>••••••••' +
            esc((intMaxMeta && intMaxMeta.tokenPreview) || '') +
            '</code></span></div></motion>';
          html = html.replace('</motion>', '</div></motion>').replace('</motion>', '</motion>').replace('</motion>', '</div>');
          html = html.replace(/<\/motion>/g, '').replace(/<motion[^>]*>/g, '');
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
          html += '</select></div><div class="forwarded-list">';
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
