/**
 * Rich text editor for Telegram / MAX (HTML subset).
 * Exposes window.ApTextEditor.
 */
(function () {
  'use strict';

  var TOOLBAR = [
    { cmd: 'bold', label: 'Ж', title: 'Жирный (Ctrl+B)', exec: 'bold', tag: 'b' },
    { cmd: 'italic', label: 'К', title: 'Курсив (Ctrl+I)', exec: 'italic', tag: 'i' },
    { cmd: 'underline', label: 'Ч', title: 'Подчёркнутый', exec: 'underline', tag: 'u' },
    { cmd: 'strike', label: 'З', title: 'Зачёркнутый', exec: 'strikeThrough', tag: 's' },
    { cmd: 'code', label: '</>', title: 'Моноширинный код', tag: 'code' },
    { cmd: 'link', label: 'Ссылка', title: 'Вставить ссылку', tag: 'a' },
    { cmd: 'quote', label: 'Цитата', title: 'Цитата', tag: 'blockquote' },
    { cmd: 'spoiler', label: 'Скрыть', title: 'Спойлер — текст скрыт до нажатия', tag: 'spoiler' },
  ];

  var DEFAULT_HINT = 'Выделите текст, затем нажмите кнопку';

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
      if (node.nodeType === Node.TEXT_NODE) return escHtml(node.textContent || '');
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
    // Telegram/MAX HTML reject <br> — keep real newlines in stored markup.
    return text;
  }

  function selectionInside(surface) {
    var sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    var range = sel.getRangeAt(0);
    if (!surface.contains(range.commonAncestorContainer) && range.commonAncestorContainer !== surface) {
      return null;
    }
    return { sel: sel, range: range, collapsed: range.collapsed };
  }

  function flashHint(root, text) {
    var hint = root.querySelector('.ap-editor-hint');
    if (!hint) return;
    hint.textContent = text;
    hint.classList.add('ap-editor-hint--warn');
    clearTimeout(hint._apHintTimer);
    hint._apHintTimer = setTimeout(function () {
      hint.textContent = DEFAULT_HINT;
      hint.classList.remove('ap-editor-hint--warn');
    }, 2200);
  }

  function wrapSelection(tag, surface, attrs) {
    surface.focus();
    var ctx = selectionInside(surface);
    if (!ctx || ctx.collapsed) return false;
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) { el.setAttribute(k, attrs[k]); });
    }
    try {
      ctx.range.surroundContents(el);
    } catch (_e) {
      var frag = ctx.range.extractContents();
      el.appendChild(frag);
      ctx.range.insertNode(el);
    }
    ctx.sel.removeAllRanges();
    var nr = document.createRange();
    nr.selectNodeContents(el);
    nr.collapse(false);
    ctx.sel.addRange(nr);
    return true;
  }

  function applyExec(exec, surface) {
    surface.focus();
    var ctx = selectionInside(surface);
    if (!ctx || ctx.collapsed) return false;
    try {
      document.execCommand(exec, false);
      return true;
    } catch (_e) {
      return false;
    }
  }

  function bindToolbar(root, surface, onChange) {
    TOOLBAR.forEach(function (item) {
      var btn = root.querySelector('[data-ap-ed="' + item.cmd + '"]');
      if (!btn) return;
      btn.addEventListener('mousedown', function (e) {
        e.preventDefault();
      });
      btn.addEventListener('click', function () {
        var ok = false;
        if (item.cmd === 'link') {
          var ctx = selectionInside(surface);
          if (!ctx || ctx.collapsed) {
            flashHint(root, 'Сначала выделите текст для ссылки');
            return;
          }
          var url = prompt('Адрес ссылки (https://…)', 'https://');
          if (!url || !/^https?:\/\//i.test(url.trim())) return;
          ok = wrapSelection('a', surface, { href: url.trim(), target: '_blank', rel: 'noopener' });
        } else if (item.cmd === 'quote') {
          ok = wrapSelection('blockquote', surface);
        } else if (item.cmd === 'spoiler') {
          var ctx2 = selectionInside(surface);
          if (!ctx2 || ctx2.collapsed) {
            flashHint(root, 'Сначала выделите текст');
            return;
          }
          var span = document.createElement('span');
          span.className = 'tg-spoiler';
          span.setAttribute('data-spoiler', '1');
          try {
            ctx2.range.surroundContents(span);
            ok = true;
          } catch (_e2) {
            span.appendChild(ctx2.range.extractContents());
            ctx2.range.insertNode(span);
            ok = true;
          }
        } else if (item.cmd === 'code') {
          ok = wrapSelection('code', surface);
        } else if (item.exec) {
          ok = applyExec(item.exec, surface);
          if (!ok) ok = wrapSelection(item.tag, surface);
        } else {
          ok = wrapSelection(item.tag, surface);
        }
        if (!ok) {
          flashHint(root, 'Сначала выделите текст');
          return;
        }
        if (onChange) onChange();
      });
    });

    surface.addEventListener('keydown', function (e) {
      if (e.ctrlKey || e.metaKey) {
        if (e.key === 'b') {
          e.preventDefault();
          applyExec('bold', surface);
          if (onChange) onChange();
        }
        if (e.key === 'i') {
          e.preventDefault();
          applyExec('italic', surface);
          if (onChange) onChange();
        }
      }
    });

    surface.addEventListener('input', function () {
      if (onChange) onChange();
    });
  }

  function mount(container, options) {
    options = options || {};
    var html = options.value || '';
    var placeholder = options.placeholder || 'Текст поста — как в канале';

    container.innerHTML =
      '<div class="ap-editor-toolbar">' +
      TOOLBAR.map(function (t) {
        return '<button type="button" class="ap-editor-btn" data-ap-ed="' + t.cmd + '" title="' + escHtml(t.title) + '">' + t.label + '</button>';
      }).join('') +
      '</div>' +
      '<div class="ap-editor-surface" contenteditable="true" data-placeholder="' + escHtml(placeholder) + '"></div>' +
      '<p class="ap-editor-hint">' + DEFAULT_HINT + '</p>';

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
      .replace(/<span class="tg-spoiler">/gi, '<span class="tg-spoiler" data-spoiler="1">')
      .replace(/\n/g, '<br>');
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
    var h = String(storedHtml)
      .replace(/<span class="tg-spoiler">/gi, '<span class="ap-spoiler">')
      .replace(/\n/g, '<br>');
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
