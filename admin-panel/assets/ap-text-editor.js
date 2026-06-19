/**
 * Rich text editor for Telegram / MAX (HTML subset).
 * Exposes window.ApTextEditor.
 */
(function () {
  'use strict';

  var TOOLBAR = [
    { cmd: 'bold', label: 'B', title: 'Жирный (Ctrl+B)', tag: 'b' },
    { cmd: 'italic', label: 'I', title: 'Курсив (Ctrl+I)', tag: 'i' },
    { cmd: 'underline', label: 'U', title: 'Подчёркнутый', tag: 'u' },
    { cmd: 'strike', label: 'S', title: 'Зачёркнутый', tag: 's' },
    { cmd: 'code', label: '{}', title: 'Код', tag: 'code' },
    { cmd: 'link', label: '🔗', title: 'Ссылка', tag: 'a' },
    { cmd: 'quote', label: '❝', title: 'Цитата', tag: 'blockquote' },
    { cmd: 'spoiler', label: '▒', title: 'Спойлер', tag: 'spoiler' },
  ];

  function escHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function hasFormatting(html) {
    return /<(?:b|strong|i|em|u|ins|s|strike|del|code|pre|a|blockquote|spoiler|span)[\s>]/i.test(html || '');
  }

  /** Normalize contenteditable output to Telegram/MAX HTML. */
  function normalizeHtml(raw) {
    if (!raw || !String(raw).trim()) return '';
    var wrap = document.createElement('div');
    wrap.innerHTML = raw;

    function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
      if (node.nodeType !== Node.ELEMENT_NODE) return '';
      var tag = node.tagName;
      if (tag === 'BR') return '\n';
      if (tag === 'P' || tag === 'DIV') {
        var inner = '';
        for (var i = 0; i < node.childNodes.length; i++) inner += walk(node.childNodes[i]);
        return inner + (tag === 'P' ? '\n' : '');
      }
      if (tag === 'B' || tag === 'STRONG') return '<b>' + children(node) + '</b>';
      if (tag === 'I' || tag === 'EM') return '<i>' + children(node) + '</i>';
      if (tag === 'U' || tag === 'INS') return '<u>' + children(node) + '</u>';
      if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') return '<s>' + children(node) + '</s>';
      if (tag === 'CODE') return '<code>' + children(node) + '</code>';
      if (tag === 'PRE') return '<pre>' + children(node) + '</pre>';
      if (tag === 'BLOCKQUOTE') return '<blockquote>' + children(node) + '</blockquote>';
      if (tag === 'A') {
        var href = node.getAttribute('href') || '';
        if (!/^https?:\/\//i.test(href)) return children(node);
        return '<a href="' + escHtml(href) + '">' + children(node) + '</a>';
      }
      if (tag === 'SPAN' && (node.classList.contains('tg-spoiler') || node.getAttribute('data-spoiler') === '1')) {
        return '<span class="tg-spoiler">' + children(node) + '</span>';
      }
      if (tag === 'SPOILER') return '<span class="tg-spoiler">' + children(node) + '</span>';
      return children(node);
    }

    function children(el) {
      var out = '';
      for (var j = 0; j < el.childNodes.length; j++) out += walk(el.childNodes[j]);
      return out;
    }

    var text = walk(wrap).replace(/\n{3,}/g, '\n\n').trim();
    return text.replace(/\n/g, '<br>');
  }

  function wrapSelection(tag, surface, attrs) {
    surface.focus();
    var sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    var range = sel.getRangeAt(0);
    if (range.collapsed) return;
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) { el.setAttribute(k, attrs[k]); });
    }
    try {
      range.surroundContents(el);
    } catch (_e) {
      var frag = range.extractContents();
      el.appendChild(frag);
      range.insertNode(el);
    }
    sel.removeAllRanges();
    var nr = document.createRange();
    nr.selectNodeContents(el);
    nr.collapse(false);
    sel.addRange(nr);
  }

  function bindToolbar(root, surface, onChange) {
    TOOLBAR.forEach(function (item) {
      var btn = root.querySelector('[data-ap-ed="' + item.cmd + '"]');
      if (!btn) return;
      btn.addEventListener('mousedown', function (e) {
        e.preventDefault();
      });
      btn.addEventListener('click', function () {
        if (item.cmd === 'link') {
          var url = prompt('URL (https://…)', 'https://');
          if (!url || !/^https?:\/\//i.test(url.trim())) return;
          wrapSelection('a', surface, { href: url.trim(), target: '_blank', rel: 'noopener' });
        } else if (item.cmd === 'quote') {
          wrapSelection('blockquote', surface);
        } else if (item.cmd === 'spoiler') {
          var span = document.createElement('span');
          span.className = 'tg-spoiler';
          span.setAttribute('data-spoiler', '1');
          surface.focus();
          var sel = window.getSelection();
          if (!sel || sel.rangeCount === 0) return;
          var range = sel.getRangeAt(0);
          if (range.collapsed) return;
          try {
            range.surroundContents(span);
          } catch (_e2) {
            span.appendChild(range.extractContents());
            range.insertNode(span);
          }
        } else {
          wrapSelection(item.tag, surface);
        }
        if (onChange) onChange();
      });
    });

    surface.addEventListener('keydown', function (e) {
      if (e.ctrlKey || e.metaKey) {
        if (e.key === 'b') { e.preventDefault(); wrapSelection('b', surface); if (onChange) onChange(); }
        if (e.key === 'i') { e.preventDefault(); wrapSelection('i', surface); if (onChange) onChange(); }
      }
    });

    surface.addEventListener('input', function () {
      if (onChange) onChange();
    });
  }

  function mount(container, options) {
    options = options || {};
    var html = options.value || '';
    var placeholder = options.placeholder || 'Введите текст…';

    container.innerHTML =
      '<div class="ap-editor-toolbar">' +
      TOOLBAR.map(function (t) {
        return '<button type="button" class="ap-editor-btn" data-ap-ed="' + t.cmd + '" title="' + escHtml(t.title) + '">' + t.label + '</button>';
      }).join('') +
      '<span class="ap-editor-hint">HTML · Telegram & MAX</span></div>' +
      '<div class="ap-editor-surface" contenteditable="true" data-placeholder="' + escHtml(placeholder) + '"></div>';

    var surface = container.querySelector('.ap-editor-surface');
    if (html) {
      surface.innerHTML = htmlToEditable(html);
    }

    bindToolbar(container, surface, options.onChange);
    return surface;
  }

  /** Convert stored messenger HTML to editable DOM. */
  function htmlToEditable(html) {
    if (!html) return '';
    return String(html)
      .replace(/<span class="tg-spoiler">/gi, '<span class="tg-spoiler" data-spoiler="1">');
  }

  function getHtml(surface) {
    if (!surface) return '';
    return normalizeHtml(surface.innerHTML);
  }

  function getPlainLength(surface) {
    return (surface && surface.textContent) ? surface.textContent.length : 0;
  }

  function setHtml(surface, html) {
    if (!surface) return;
    surface.innerHTML = htmlToEditable(html);
  }

  /** Safe preview HTML (same subset). */
  function previewHtml(storedHtml) {
    if (!storedHtml) return '';
    var h = storedHtml;
    h = h.replace(/<span class="tg-spoiler">/gi, '<span class="ap-spoiler">');
    return h;
  }

  function isEmpty(html) {
    if (!html || !String(html).trim()) return true;
    var d = document.createElement('div');
    d.innerHTML = String(html).replace(/<br\s*\/?>/gi, '\n');
    return !(d.textContent || '').trim();
  }

  window.ApTextEditor = {
    mount: mount,
    getHtml: getHtml,
    setHtml: setHtml,
    getPlainLength: getPlainLength,
    normalizeHtml: normalizeHtml,
    previewHtml: previewHtml,
    hasFormatting: hasFormatting,
    isEmpty: isEmpty,
  };
})();
