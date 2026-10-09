/*! AWebChatbot widget v1.0.0 — AI chatbot + live chat. Embed:
 *  <script src="https://YOUR-WORKER/widget.js" data-key="pk_..." async></script>
 */
(function () {
  'use strict';
  if (window.AWebChatbot && window.AWebChatbot.__loaded) return;

  var script =
    document.currentScript ||
    document.querySelector('script[src*="widget.js"][data-key]') ||
    document.querySelector('script[data-awebchatbot-key]');
  var KEY = (script && (script.getAttribute('data-key') || script.getAttribute('data-awebchatbot-key'))) ||
    (window.AWebChatbotConfig && window.AWebChatbotConfig.key);
  if (!KEY) {
    console.warn('[AWebChatbot] Missing data-key on the widget script tag.');
    return;
  }
  var BASE = (script && script.getAttribute('data-base')) ||
    (window.AWebChatbotConfig && window.AWebChatbotConfig.base) ||
    (script && script.src ? new URL(script.src, location.href).origin : location.origin);
  var WS_BASE = BASE.replace(/^http/, 'ws');
  var STORE_KEY = 'awc:' + KEY;

  // ---------------------------------------------------------------------------------------------
  // State & storage
  // ---------------------------------------------------------------------------------------------
  var memoryStore = {};
  function load() {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    } catch (e) {
      return memoryStore;
    }
  }
  function save(patch) {
    var data = load();
    for (var k in patch) data[k] = patch[k];
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(data));
    } catch (e) {
      memoryStore = data;
    }
    return data;
  }
  function randomId() {
    var a = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(a);
    return 'v_' + Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  var stored = load();
  if (!stored.visitorId) stored = save({ visitorId: randomId() });

  var state = {
    config: null,
    open: false,
    conversationId: stored.conversationId || null,
    token: stored.token || null,
    messages: [],
    mode: 'bot',
    status: 'open',
    sending: false,
    streamingEl: null,
    streamingText: '',
    unread: 0,
    socket: null,
    socketRetry: 0,
    pingTimer: null,
    agentTypingTimer: null,
    lastTypingSent: 0,
    rated: false,
    listeners: {},
    turnstileToken: null
  };

  function emit(name, data) {
    (state.listeners[name] || []).forEach(function (fn) {
      try { fn(data); } catch (e) { console.error(e); }
    });
    try { window.dispatchEvent(new CustomEvent('awebchatbot:' + name, { detail: data })); } catch (e) { /* old browsers */ }
  }

  // ---------------------------------------------------------------------------------------------
  // HTTP helpers
  // ---------------------------------------------------------------------------------------------
  function api(path, options) {
    options = options || {};
    var headers = options.headers || {};
    if (options.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.json);
    }
    if (state.token && options.auth !== false) headers.Authorization = 'Bearer ' + state.token;
    return fetch(BASE + path, { method: options.method || 'GET', headers: headers, body: options.body, credentials: 'omit' })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok) {
            var err = new Error(data.error || ('Request failed (' + res.status + ')'));
            err.status = res.status;
            throw err;
          }
          return data;
        });
      });
  }

  // ---------------------------------------------------------------------------------------------
  // Markdown-lite rendering (escaped first, then a safe subset of formatting)
  // ---------------------------------------------------------------------------------------------
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function safeUrl(u) {
    u = u.replace(/&amp;/g, '&');
    return /^(https?:|mailto:|tel:|\/)/i.test(u) ? esc(u) : '#';
  }
  function inline(text) {
    return text
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (_, label, url) {
        return '<a href="' + safeUrl(url) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
      })
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, function (_, pre, url) {
        return pre + '<a href="' + safeUrl(url) + '" target="_blank" rel="noopener noreferrer">' + url + '</a>';
      });
  }
  function md(text) {
    var lines = esc(text || '').split('\n');
    var html = '';
    var list = null;
    lines.forEach(function (line) {
      var bullet = line.match(/^\s*[-*•]\s+(.*)$/);
      var numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
      var quote = line.match(/^&gt;\s?(.*)$/);
      if (bullet || numbered) {
        var type = bullet ? 'ul' : 'ol';
        if (list !== type) {
          if (list) html += '</' + list + '>';
          html += '<' + type + '>';
          list = type;
        }
        html += '<li>' + inline((bullet || numbered)[1]) + '</li>';
        return;
      }
      if (list) { html += '</' + list + '>'; list = null; }
      if (quote) html += '<blockquote>' + inline(quote[1]) + '</blockquote>';
      else if (/^#{1,4}\s/.test(line)) html += '<p><strong>' + inline(line.replace(/^#{1,4}\s/, '')) + '</strong></p>';
      else if (line.trim() === '') html += '<div class="sp"></div>';
      else html += '<p>' + inline(line) + '</p>';
    });
    if (list) html += '</' + list + '>';
    return html;
  }

  // ---------------------------------------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------------------------------------
  var host = document.createElement('div');
  host.id = 'awebchatbot-root';
  host.style.cssText = 'position:fixed;z-index:2147483000;bottom:0;right:0;width:0;height:0;';
  var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
  var els = {};

  function css(c) {
    return '' +
      ':host{all:initial}' +
      '*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Inter,Helvetica,Arial,sans-serif}' +
      '.wrap{--brand:' + c.brandColor + ';--bg:#ffffff;--fg:#111827;--muted:#6b7280;--line:#e5e7eb;--bubble:#f3f4f6;--shadow:0 12px 48px rgba(0,0,0,.18)}' +
      '.wrap.dark{--bg:#111318;--fg:#f3f4f6;--muted:#9ca3af;--line:#2a2e37;--bubble:#1d2129;--shadow:0 12px 48px rgba(0,0,0,.6)}' +
      '.launcher{position:fixed;bottom:20px;' + c.position + ':20px;height:56px;min-width:56px;padding:0 18px;border-radius:28px;border:0;background:var(--brand);color:#fff;display:flex;align-items:center;gap:8px;cursor:pointer;box-shadow:var(--shadow);font-size:15px;font-weight:600;transition:transform .15s}' +
      '.launcher:hover{transform:translateY(-2px)}.launcher:focus-visible{outline:3px solid #93c5fd;outline-offset:2px}' +
      '.launcher svg{width:24px;height:24px;flex:none}.launcher .lbl{white-space:nowrap}' +
      '.badge{position:absolute;top:-4px;' + (c.position === 'left' ? 'left' : 'right') + ':-4px;background:#ef4444;color:#fff;border-radius:10px;min-width:20px;height:20px;font-size:12px;display:flex;align-items:center;justify-content:center;padding:0 6px}' +
      '.panel{position:fixed;bottom:88px;' + c.position + ':20px;width:380px;max-width:calc(100vw - 24px);height:600px;max-height:calc(100vh - 110px);background:var(--bg);color:var(--fg);border-radius:18px;box-shadow:var(--shadow);display:flex;flex-direction:column;overflow:hidden;opacity:0;transform:translateY(12px) scale(.98);pointer-events:none;transition:opacity .18s,transform .18s;border:1px solid var(--line)}' +
      '.panel.open{opacity:1;transform:none;pointer-events:auto}' +
      '@media (max-width:480px){.panel{inset:0;width:100vw;max-width:100vw;height:100%;max-height:100%;border-radius:0;bottom:0}.panel.open~.launcher{display:none}}' +
      '.head{background:var(--brand);color:#fff;padding:14px 14px 14px 16px;display:flex;align-items:center;gap:10px}' +
      '.head img{width:32px;height:32px;border-radius:50%;object-fit:cover;background:#fff}' +
      '.head .t{flex:1;min-width:0}.head .n{font-weight:700;font-size:15px}.head .s{font-size:12px;opacity:.85;display:flex;align-items:center;gap:6px}' +
      '.dot{width:8px;height:8px;border-radius:50%;background:#a7f3d0;display:inline-block}.dot.off{background:#d1d5db}' +
      '.hbtn{background:rgba(255,255,255,.16);border:0;color:#fff;border-radius:8px;width:32px;height:32px;cursor:pointer;display:flex;align-items:center;justify-content:center}' +
      '.hbtn:hover{background:rgba(255,255,255,.28)}.hbtn svg{width:18px;height:18px}' +
      '.menu{position:absolute;top:58px;right:12px;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:10px;box-shadow:var(--shadow);display:none;flex-direction:column;min-width:190px;z-index:3;overflow:hidden}' +
      '.menu.show{display:flex}.menu button{background:none;border:0;color:var(--fg);text-align:left;padding:10px 14px;font-size:14px;cursor:pointer}.menu button:hover{background:var(--bubble)}' +
      '.body{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px;scroll-behavior:smooth}' +
      '.msg{max-width:85%;font-size:14px;line-height:1.45;word-wrap:break-word;overflow-wrap:anywhere}' +
      '.msg .b{padding:10px 13px;border-radius:16px}' +
      '.msg.visitor{align-self:flex-end}.msg.visitor .b{background:var(--brand);color:#fff;border-bottom-right-radius:4px}' +
      '.msg.visitor .b a{color:#fff}' +
      '.msg.bot,.msg.agent{align-self:flex-start}.msg.bot .b,.msg.agent .b{background:var(--bubble);border-bottom-left-radius:4px}' +
      '.msg.system{align-self:center;font-size:12px;color:var(--muted);text-align:center}' +
      '.who{font-size:11px;color:var(--muted);margin:0 4px 3px}' +
      '.b p{margin:0}.b .sp{height:6px}.b ul,.b ol{margin:4px 0;padding-left:20px}.b blockquote{margin:4px 0;padding-left:10px;border-left:3px solid var(--line);color:var(--muted)}' +
      '.b code{background:rgba(127,127,127,.15);padding:1px 4px;border-radius:4px;font-family:ui-monospace,monospace;font-size:13px}.b a{color:var(--brand)}' +
      '.src{display:flex;flex-wrap:wrap;gap:6px;margin:6px 2px 0}.src a{font-size:11px;color:var(--muted);border:1px solid var(--line);border-radius:10px;padding:2px 8px;text-decoration:none;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.att{display:block;margin-top:6px;max-width:220px;border-radius:10px}.attf{display:inline-block;margin-top:6px;font-size:12px}' +
      '.btns{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}' +
      '.btns button{border:1px solid var(--brand);background:transparent;color:var(--brand);border-radius:16px;padding:6px 12px;font-size:13px;cursor:pointer}' +
      '.btns button:hover{background:var(--brand);color:#fff}' +
      '.typing{align-self:flex-start;background:var(--bubble);border-radius:16px;padding:12px 14px;display:none;gap:4px}.typing.show{display:flex}' +
      '.typing i{width:6px;height:6px;border-radius:50%;background:var(--muted);animation:bl 1.2s infinite}.typing i:nth-child(2){animation-delay:.2s}.typing i:nth-child(3){animation-delay:.4s}' +
      '@keyframes bl{0%,60%,100%{opacity:.3}30%{opacity:1}}' +
      '.form{background:var(--bubble);border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:8px;align-self:stretch}' +
      '.form label{font-size:13px;color:var(--muted)}.form input{border:1px solid var(--line);background:var(--bg);color:var(--fg);border-radius:8px;padding:9px 10px;font-size:14px}' +
      '.form button,.primary{background:var(--brand);color:#fff;border:0;border-radius:8px;padding:9px 12px;font-size:14px;cursor:pointer;font-weight:600}' +
      '.rate{align-self:center;text-align:center;font-size:13px;color:var(--muted)}.rate button{background:none;border:0;font-size:22px;cursor:pointer;padding:2px}' +
      '.foot{border-top:1px solid var(--line);padding:10px;display:flex;gap:8px;align-items:flex-end;background:var(--bg)}' +
      '.foot textarea{flex:1;resize:none;border:1px solid var(--line);background:var(--bg);color:var(--fg);border-radius:12px;padding:10px 12px;font-size:14px;max-height:120px;min-height:42px;line-height:1.35;outline:none}' +
      '.foot textarea:focus{border-color:var(--brand)}' +
      '.ibtn{width:40px;height:40px;border-radius:10px;border:0;display:flex;align-items:center;justify-content:center;cursor:pointer;flex:none;background:transparent;color:var(--muted)}' +
      '.ibtn.send{background:var(--brand);color:#fff}.ibtn:disabled{opacity:.5;cursor:default}.ibtn svg{width:20px;height:20px}' +
      '.disc{font-size:11px;color:var(--muted);text-align:center;padding:0 12px 8px;background:var(--bg)}' +
      '.err{color:#ef4444;font-size:12px;text-align:center}' +
      '.powered{font-size:10px;color:var(--muted);text-align:center;padding-bottom:6px;background:var(--bg)}';
  }

  var ICON_CHAT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  var ICON_CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  var ICON_SEND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/></svg>';
  var ICON_CLIP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>';
  var ICON_MORE = '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>';

  function isDark(c) {
    if (c.theme === 'dark') return true;
    if (c.theme === 'light') return false;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function build(c) {
    var style = document.createElement('style');
    style.textContent = css(c);
    root.appendChild(style);
    var wrap = document.createElement('div');
    wrap.className = 'wrap' + (isDark(c) ? ' dark' : '');
    wrap.innerHTML =
      '<div class="panel" role="dialog" aria-label="' + esc(c.botName) + '" aria-modal="false">' +
        '<div class="head">' +
          (c.logoUrl ? '<img alt="" src="' + safeUrl(c.logoUrl) + '">' : '') +
          '<div class="t"><div class="n">' + esc(c.botName) + '</div><div class="s"><span class="dot"></span><span class="st"></span></div></div>' +
          '<button class="hbtn more" aria-label="Options">' + ICON_MORE + '</button>' +
          '<button class="hbtn close" aria-label="Close chat">' + ICON_CLOSE + '</button>' +
        '</div>' +
        '<div class="menu" role="menu">' +
          (c.handoffEnabled ? '<button class="m-human" role="menuitem">Talk to a human</button>' : '') +
          '<button class="m-email" role="menuitem">Email me the reply</button>' +
          '<button class="m-new" role="menuitem">Start a new conversation</button>' +
        '</div>' +
        '<div class="body" aria-live="polite"></div>' +
        '<div class="foot">' +
          '<input type="file" class="file" hidden accept="image/*,application/pdf,text/plain">' +
          '<button class="ibtn clip" aria-label="Attach a file">' + ICON_CLIP + '</button>' +
          '<textarea rows="1" aria-label="Message" placeholder="' + esc(c.placeholder) + '"></textarea>' +
          '<button class="ibtn send" aria-label="Send">' + ICON_SEND + '</button>' +
        '</div>' +
        (c.disclaimer ? '<div class="disc">' + esc(c.disclaimer) + '</div>' : '') +
      '</div>' +
      '<button class="launcher" aria-label="' + esc(c.launcherText || 'Open chat') + '">' + ICON_CHAT +
        (c.launcherText ? '<span class="lbl">' + esc(c.launcherText) + '</span>' : '') + '</button>';
    root.appendChild(wrap);
    els.wrap = wrap;
    els.panel = wrap.querySelector('.panel');
    els.body = wrap.querySelector('.body');
    els.input = wrap.querySelector('textarea');
    els.send = wrap.querySelector('.send');
    els.launcher = wrap.querySelector('.launcher');
    els.status = wrap.querySelector('.st');
    els.dot = wrap.querySelector('.dot');
    els.menu = wrap.querySelector('.menu');
    els.file = wrap.querySelector('.file');
    els.typing = document.createElement('div');
    els.typing.className = 'typing';
    els.typing.innerHTML = '<i></i><i></i><i></i>';

    els.launcher.addEventListener('click', function () { toggle(); });
    wrap.querySelector('.close').addEventListener('click', function () { close(); });
    wrap.querySelector('.more').addEventListener('click', function (e) {
      e.stopPropagation();
      els.menu.classList.toggle('show');
    });
    wrap.addEventListener('click', function () { els.menu.classList.remove('show'); });
    var human = wrap.querySelector('.m-human');
    if (human) human.addEventListener('click', function () { requestHuman(); });
    wrap.querySelector('.m-email').addEventListener('click', function () { showEmailForm('Where should we send replies?'); });
    wrap.querySelector('.m-new').addEventListener('click', function () { reset(true); });
    els.send.addEventListener('click', function () { submit(); });
    els.input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        submit();
      }
    });
    els.input.addEventListener('input', function () {
      els.input.style.height = 'auto';
      els.input.style.height = Math.min(120, els.input.scrollHeight) + 'px';
      sendTyping();
    });
    wrap.querySelector('.clip').addEventListener('click', function () { els.file.click(); });
    els.file.addEventListener('change', function () {
      if (els.file.files && els.file.files[0]) upload(els.file.files[0]);
      els.file.value = '';
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && state.open) close();
    });
    if (window.matchMedia && c.theme === 'auto') {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      var onChange = function () { wrap.classList.toggle('dark', mq.matches); };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
    }
    updateStatus();
  }

  function updateStatus() {
    if (!els.status || !state.config) return;
    var online = state.config.agentsOnline > 0;
    if (state.mode === 'human') {
      els.status.textContent = online ? 'Our team is here' : 'Team will reply soon';
    } else {
      els.status.textContent = online ? 'AI assistant · team online' : 'AI assistant';
    }
    els.dot.classList.toggle('off', !online && state.mode === 'human');
  }

  function setBadge() {
    var badge = els.launcher.querySelector('.badge');
    if (state.unread > 0 && !state.open) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'badge';
        els.launcher.appendChild(badge);
      }
      badge.textContent = state.unread > 9 ? '9+' : String(state.unread);
    } else if (badge) {
      badge.remove();
    }
  }

  function scrollDown() {
    els.body.scrollTop = els.body.scrollHeight;
  }

  function whoLabel(m) {
    if (m.role === 'agent') return m.authorName || 'Team';
    if (m.role === 'bot') return state.config.botName;
    return '';
  }

  function renderMessage(m) {
    if (m.meta && m.meta.note) return null; // internal notes never reach the widget
    var el = document.createElement('div');
    el.className = 'msg ' + m.role;
    el.dataset.id = m.id;
    var html = '';
    if (m.role === 'agent' || m.role === 'bot') html += '<div class="who">' + esc(whoLabel(m)) + '</div>';
    if (m.role === 'system') {
      html += esc(m.content);
    } else {
      html += '<div class="b">' + md(m.content);
      (m.attachments || []).forEach(function (a) {
        var url = a.url.indexOf('http') === 0 ? a.url : BASE + a.url;
        if (/^image\//.test(a.type)) html += '<a href="' + esc(url) + '" target="_blank" rel="noopener"><img class="att" alt="' + esc(a.name) + '" src="' + esc(url) + '"></a>';
        else html += '<a class="attf" href="' + esc(url) + '" target="_blank" rel="noopener">📎 ' + esc(a.name) + '</a>';
      });
      html += '</div>';
      var sources = (m.meta && m.meta.sources) || [];
      if (m.role === 'bot' && state.config.showSources && sources.length) {
        html += '<div class="src">' + sources.map(function (s) {
          return '<a href="' + safeUrl(s.url) + '" target="_blank" rel="noopener" title="' + esc(s.title) + '">' + esc(s.title) + '</a>';
        }).join('') + '</div>';
      }
    }
    el.innerHTML = html;
    return el;
  }

  function renderButtons() {
    var old = els.body.querySelectorAll('.btns');
    for (var i = 0; i < old.length; i++) old[i].remove();
    var last = state.messages[state.messages.length - 1];
    if (!last || !last.buttons || !last.buttons.length || last.role !== 'bot') return;
    var holder = els.body.querySelector('[data-id="' + last.id + '"]');
    if (!holder) return;
    var box = document.createElement('div');
    box.className = 'btns';
    last.buttons.forEach(function (label) {
      var b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('click', function () { send(label); });
      box.appendChild(b);
    });
    holder.appendChild(box);
  }

  function upsertMessage(m, fromSocket) {
    for (var i = 0; i < state.messages.length; i++) {
      if (state.messages[i].id === m.id) return false;
    }
    if (m.meta && m.meta.note) return false;
    state.messages.push(m);
    var el = renderMessage(m);
    if (!el) return false;
    els.body.insertBefore(el, els.typing.parentNode === els.body ? els.typing : null);
    if (m.meta && m.meta.askEmail) showEmailForm('Your email');
    renderButtons();
    scrollDown();
    if (fromSocket && m.role !== 'visitor') {
      hideAgentTyping();
      if (!state.open) {
        state.unread++;
        setBadge();
      }
    }
    emit('message', m);
    return true;
  }

  function renderAll() {
    els.body.innerHTML = '';
    els.input.disabled = false;
    var list = state.messages;
    state.messages = [];
    list.forEach(function (m) { upsertMessage(m, false); });
    els.body.appendChild(els.typing);
    if (state.status === 'closed') showRating();
    scrollDown();
  }

  function showTyping(on) {
    if (els.typing.parentNode !== els.body) els.body.appendChild(els.typing);
    els.typing.classList.toggle('show', !!on);
    if (on) scrollDown();
  }

  function hideAgentTyping() {
    clearTimeout(state.agentTypingTimer);
    if (!state.sending) showTyping(false);
  }

  function showError(text) {
    var el = document.createElement('div');
    el.className = 'err';
    el.textContent = text;
    els.body.appendChild(el);
    scrollDown();
    setTimeout(function () { el.remove(); }, 6000);
  }

  function showEmailForm(label) {
    if (els.body.querySelector('.form.email')) return;
    var form = document.createElement('form');
    form.className = 'form email';
    form.innerHTML = '<label>' + esc(label) + '</label><input type="email" required placeholder="you@example.com" autocomplete="email"><button type="submit">Save</button>';
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var value = form.querySelector('input').value.trim();
      identify({ email: value }).then(function () {
        form.innerHTML = '<label>Thanks! We\'ll follow up at ' + esc(value) + '.</label>';
      }).catch(function (err) { showError(err.message); });
    });
    els.body.insertBefore(form, els.typing.parentNode === els.body ? els.typing : null);
    scrollDown();
    form.querySelector('input').focus();
  }

  function showPrechat() {
    els.body.innerHTML = '';
    els.input.disabled = true;
    var form = document.createElement('form');
    form.className = 'form';
    form.innerHTML = '<label>' + esc(state.config.greeting) + '</label>' +
      '<input name="name" placeholder="Your name" autocomplete="name">' +
      '<input name="email" type="email" required placeholder="you@example.com" autocomplete="email">' +
      '<button type="submit">Start chat</button>';
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var name = form.querySelector('[name=name]').value.trim();
      var email = form.querySelector('[name=email]').value.trim();
      save({ pendingIdentity: { name: name, email: email } });
      ensureConversation().then(renderAll).catch(function (err) { showError(err.message); });
    });
    els.body.appendChild(form);
  }

  function showRating() {
    if (state.rated || els.body.querySelector('.rate')) return;
    var box = document.createElement('div');
    box.className = 'rate';
    box.innerHTML = '<div>How did we do?</div>' + [1, 2, 3, 4, 5].map(function (n) {
      return '<button aria-label="' + n + ' stars" data-n="' + n + '">☆</button>';
    }).join('');
    box.addEventListener('click', function (e) {
      var n = e.target && e.target.getAttribute && e.target.getAttribute('data-n');
      if (!n) return;
      api('/v1/conversations/' + state.conversationId + '/rate', { method: 'POST', json: { rating: Number(n) } })
        .then(function () {
          state.rated = true;
          box.innerHTML = 'Thanks for your feedback!';
        })
        .catch(function (err) { showError(err.message); });
    });
    els.body.appendChild(box);
    scrollDown();
  }

  // ---------------------------------------------------------------------------------------------
  // Turnstile (optional bot protection)
  // ---------------------------------------------------------------------------------------------
  function getTurnstileToken() {
    var siteKey = state.config && state.config.turnstileSiteKey;
    if (!siteKey) return Promise.resolve(null);
    if (state.turnstileToken) return Promise.resolve(state.turnstileToken);
    return new Promise(function (resolve) {
      function render() {
        var holder = document.createElement('div');
        holder.style.cssText = 'position:fixed;bottom:90px;right:20px;z-index:2147483001';
        document.body.appendChild(holder);
        window.turnstile.render(holder, {
          sitekey: siteKey,
          appearance: 'interaction-only',
          callback: function (token) {
            state.turnstileToken = token;
            setTimeout(function () { holder.remove(); }, 500);
            resolve(token);
          },
          'error-callback': function () { resolve(null); }
        });
      }
      if (window.turnstile) return render();
      var s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.async = true;
      s.onload = render;
      s.onerror = function () { resolve(null); };
      document.head.appendChild(s);
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Conversation lifecycle
  // ---------------------------------------------------------------------------------------------
  var starting = null;
  function ensureConversation() {
    if (state.conversationId && state.token) return Promise.resolve();
    if (starting) return starting;
    starting = getTurnstileToken().then(function (turnstileToken) {
      return api('/v1/conversations', {
        method: 'POST',
        auth: false,
        json: {
          key: KEY,
          visitorId: load().visitorId,
          pageUrl: location.href,
          referrer: document.referrer,
          locale: navigator.language,
          turnstileToken: turnstileToken
        }
      });
    }).then(function (data) {
      state.conversationId = data.conversation.id;
      state.token = data.token;
      state.mode = data.conversation.mode;
      state.status = data.conversation.status;
      state.messages = data.messages || [];
      state.rated = false;
      save({ conversationId: state.conversationId, token: state.token, visitorId: data.visitorId });
      var pending = load().pendingIdentity;
      if (pending) {
        identify(pending).catch(function () {});
        save({ pendingIdentity: null });
      }
      connectSocket();
      emit('conversation', { id: state.conversationId });
    }).finally(function () { starting = null; });
    return starting;
  }

  function loadHistory() {
    return api('/v1/conversations/' + state.conversationId + '/messages').then(function (data) {
      state.messages = data.messages || [];
      state.mode = data.conversation.mode;
      state.status = data.conversation.status;
      state.rated = !!data.conversation.rating;
      connectSocket();
    }).catch(function (err) {
      if (err.status === 401 || err.status === 404) {
        state.conversationId = null;
        state.token = null;
        save({ conversationId: null, token: null });
        return ensureConversation();
      }
      throw err;
    });
  }

  function connectSocket() {
    if (!state.conversationId || !state.token || !window.WebSocket) return;
    if (state.socket && (state.socket.readyState === 0 || state.socket.readyState === 1)) return;
    var ws = new WebSocket(WS_BASE + '/v1/ws/' + state.conversationId + '?token=' + encodeURIComponent(state.token));
    state.socket = ws;
    ws.onopen = function () {
      state.socketRetry = 0;
      clearInterval(state.pingTimer);
      state.pingTimer = setInterval(function () {
        if (ws.readyState === 1) ws.send('{"type":"ping"}');
      }, 25000);
    };
    ws.onmessage = function (ev) {
      var data;
      try { data = JSON.parse(ev.data); } catch (e) { return; }
      if (data.type === 'message' && data.message) {
        // While our own request is streaming, the SSE response delivers bot messages.
        if (state.sending && data.message.role === 'bot') return;
        if (data.message.role === 'agent' && state.config) {
          state.config.agentsOnline = Math.max(1, state.config.agentsOnline || 0);
          state.mode = 'human';
          updateStatus();
        }
        upsertMessage(data.message, true);
      } else if (data.type === 'typing' && data.role === 'agent') {
        showTyping(true);
        clearTimeout(state.agentTypingTimer);
        state.agentTypingTimer = setTimeout(hideAgentTyping, 4000);
      } else if (data.type === 'status') {
        if (data.mode) state.mode = data.mode;
        if (data.status) {
          state.status = data.status;
          if (data.status === 'closed') showRating();
        }
        updateStatus();
      }
    };
    ws.onclose = function () {
      clearInterval(state.pingTimer);
      state.socket = null;
      if (!state.conversationId) return;
      var delay = Math.min(30000, 1000 * Math.pow(2, state.socketRetry++));
      setTimeout(function () {
        if (document.visibilityState !== 'hidden' || state.open) connectSocket();
      }, delay);
    };
  }

  function sendTyping() {
    var now = Date.now();
    if (now - state.lastTypingSent < 3000) return;
    state.lastTypingSent = now;
    if (state.socket && state.socket.readyState === 1) state.socket.send('{"type":"typing"}');
  }

  function readSse(res, handlers) {
    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';
    function pump() {
      return reader.read().then(function (r) {
        if (r.done) return;
        buffer += decoder.decode(r.value, { stream: true });
        var idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          var raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          var event = 'message';
          var data = '';
          raw.split('\n').forEach(function (line) {
            if (line.indexOf('event:') === 0) event = line.slice(6).trim();
            else if (line.indexOf('data:') === 0) data += line.slice(5).trim();
          });
          if (data && handlers[event]) {
            try { handlers[event](JSON.parse(data)); } catch (e) { console.error(e); }
          }
        }
        return pump();
      });
    }
    return pump();
  }

  function startStreamingBubble() {
    var el = document.createElement('div');
    el.className = 'msg bot streaming';
    el.innerHTML = '<div class="who">' + esc(state.config.botName) + '</div><div class="b"></div>';
    els.body.insertBefore(el, els.typing);
    state.streamingEl = el;
    state.streamingText = '';
  }

  function endStreamingBubble() {
    if (state.streamingEl) state.streamingEl.remove();
    state.streamingEl = null;
    state.streamingText = '';
  }

  function send(text, attachments) {
    text = (text || '').trim();
    if ((!text && !(attachments && attachments.length)) || state.sending) return Promise.resolve();
    state.sending = true;
    els.send.disabled = true;
    if (els.body.querySelector('.form:not(.email)')) els.body.innerHTML = '';
    if (els.typing.parentNode !== els.body) els.body.appendChild(els.typing);
    var buttons = els.body.querySelectorAll('.btns');
    for (var i = 0; i < buttons.length; i++) buttons[i].remove();
    var pendingEl = renderMessage({ id: 'pending', role: 'visitor', content: text, attachments: attachments || [], meta: {} });
    els.body.insertBefore(pendingEl, els.typing);
    showTyping(true);
    return ensureConversation().then(function () {
      if (els.typing.parentNode !== els.body) els.body.appendChild(els.typing);
      return fetch(BASE + '/v1/conversations/' + state.conversationId + '/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.token },
        body: JSON.stringify({ content: text, attachments: attachments || [] })
      });
    }).then(function (res) {
      if (!res.ok) {
        return res.json().catch(function () { return {}; }).then(function (d) { throw new Error(d.error || 'Message failed'); });
      }
      return readSse(res, {
        message: function (m) {
          if (m.role === 'visitor') pendingEl.remove();
          if (m.role === 'bot') endStreamingBubble();
          upsertMessage(m, false);
          if (m.role === 'bot') showTyping(false);
        },
        delta: function (d) {
          showTyping(false);
          if (!state.streamingEl) startStreamingBubble();
          state.streamingText += d.text;
          state.streamingEl.querySelector('.b').innerHTML = md(state.streamingText);
          scrollDown();
        },
        status: function (s) {
          if (s.typing) showTyping(true);
          if (s.mode) state.mode = s.mode;
          updateStatus();
        },
        done: function (d) {
          if (d.conversation) {
            state.mode = d.conversation.mode;
            state.status = d.conversation.status;
          }
          updateStatus();
        },
        error: function (e) { showError(e.message || 'Something went wrong'); }
      });
    }).catch(function (err) {
      showError(err.message || 'Could not send message');
      if (pendingEl.parentNode) pendingEl.style.opacity = '0.5';
    }).finally(function () {
      state.sending = false;
      els.send.disabled = false;
      endStreamingBubble();
      showTyping(false);
      renderButtons();
    });
  }

  function submit() {
    var text = els.input.value;
    if (!text.trim()) return;
    els.input.value = '';
    els.input.style.height = 'auto';
    send(text);
  }

  function upload(file) {
    if (file.size > 5 * 1024 * 1024) return showError('File is larger than 5 MB');
    ensureConversation().then(function () {
      var form = new FormData();
      form.append('file', file);
      return api('/v1/conversations/' + state.conversationId + '/upload', { method: 'POST', body: form });
    }).then(function (att) {
      return send(els.input.value.trim() || 'Sent a file: ' + att.name, [att]);
    }).then(function () {
      els.input.value = '';
    }).catch(function (err) { showError(err.message); });
  }

  function requestHuman() {
    ensureConversation().then(function () {
      return api('/v1/conversations/' + state.conversationId + '/handoff', { method: 'POST', json: {} });
    }).then(function (data) {
      state.mode = 'human';
      (data.messages || []).forEach(function (m) { upsertMessage(m, false); });
      updateStatus();
    }).catch(function (err) { showError(err.message); });
  }

  function identify(data) {
    data = data || {};
    if (!state.conversationId) {
      save({ pendingIdentity: data });
      return Promise.resolve();
    }
    return api('/v1/conversations/' + state.conversationId + '/identify', { method: 'POST', json: data });
  }

  function open() {
    if (!els.panel) return;
    state.open = true;
    els.panel.classList.add('open');
    state.unread = 0;
    setBadge();
    var ready;
    if (state.conversationId && state.token) ready = loadHistory();
    else if (state.config.collectEmailBeforeChat && !(load().pendingIdentity || {}).email) {
      showPrechat();
      ready = null;
    } else ready = ensureConversation();
    if (ready) {
      showTyping(true);
      ready.then(renderAll).catch(function (err) { showError(err.message); }).finally(function () { showTyping(false); });
    }
    setTimeout(function () { els.input.focus(); }, 150);
    emit('open', {});
  }

  function close() {
    if (!els.panel) return;
    state.open = false;
    els.panel.classList.remove('open');
    els.menu.classList.remove('show');
    emit('close', {});
  }

  function toggle() {
    if (state.open) close();
    else open();
  }

  function reset(reopen) {
    if (state.socket) {
      state.conversationId = null;
      try { state.socket.close(); } catch (e) { /* ignore */ }
    }
    state.conversationId = null;
    state.token = null;
    state.messages = [];
    state.mode = 'bot';
    state.status = 'open';
    state.rated = false;
    save({ conversationId: null, token: null });
    if (els.body) els.body.innerHTML = '';
    if (reopen) {
      els.menu.classList.remove('show');
      ensureConversation().then(renderAll).catch(function (err) { showError(err.message); });
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------------------------
  var queued = (window.AWebChatbot && window.AWebChatbot.q) || [];
  window.AWebChatbot = {
    __loaded: true,
    ready: false,
    open: open,
    close: close,
    toggle: toggle,
    identify: identify,
    sendMessage: function (text) { open(); return send(text); },
    reset: function () { reset(false); },
    on: function (name, fn) { (state.listeners[name] = state.listeners[name] || []).push(fn); }
  };

  function init() {
    api('/v1/config?key=' + encodeURIComponent(KEY), { auth: false }).then(function (config) {
      state.config = config;
      (document.body || document.documentElement).appendChild(host);
      build(config);
      if (state.conversationId) connectSocket();
      window.AWebChatbot.ready = true;
      queued.forEach(function (call) {
        var fn = window.AWebChatbot[call[0]];
        if (typeof fn === 'function') fn.apply(null, call.slice(1));
      });
      emit('ready', {});
      if (/[?&#]chat=open\b/.test(location.href)) open();
    }).catch(function (err) {
      console.warn('[AWebChatbot] Widget disabled:', err.message);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
