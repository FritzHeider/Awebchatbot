/* AWebChatbot shared inbox — vanilla JS single-page app served by the Worker at /inbox/ */
(function () {
  'use strict';

  var TOKEN_KEY = 'awc_admin_token';
  var WS_KEY = 'awc_admin_workspace';
  var app = document.getElementById('app');

  var S = {
    token: localStorage.getItem(TOKEN_KEY) || '',
    me: null,
    workspaces: [],
    ws: null,
    agents: [],
    route: { view: 'inbox', convId: null },
    filter: { status: 'open', assignee: '', mode: '', q: '' },
    conversations: [],
    thread: null,
    socket: null,
    socketRetry: 0,
    presence: { agents: [], visitors: 0 },
    noteMode: false,
    typingTimer: null,
    lastTyping: 0
  };

  // ------------------------------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------------------------------
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'html') el.innerHTML = v;
        else if (k.indexOf('on') === 0 && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'value') el.value = v;
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, v);
      });
    }
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el) {
    for (var i = 1; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined || child === false) continue;
      if (Array.isArray(child)) {
        child.forEach(function (c) { append(el, c); });
        continue;
      }
      el.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
    }
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function linkify(text) {
    return esc(text)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  }
  function ago(ts) {
    if (!ts) return '';
    var s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return 'now';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    return Math.floor(s / 86400) + 'd';
  }
  function safeHref(u) { return /^https?:\/\//i.test(String(u || '')) ? String(u) : '#'; }
  function fmt(ts) { return ts ? new Date(ts).toLocaleString() : '—'; }
  function toast(text) {
    var t = h('div', { class: 'toast', text: text });
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 3200);
  }
  function api(path, opts) {
    opts = opts || {};
    var headers = { Authorization: 'Bearer ' + S.token };
    var body = opts.body;
    if (opts.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.json);
    }
    return fetch('/admin' + path, { method: opts.method || 'GET', headers: headers, body: body }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (res.status === 401) {
          logout();
          throw new Error('Session expired');
        }
        if (!res.ok) throw new Error(data.error || 'Request failed (' + res.status + ')');
        return data;
      });
    });
  }
  function wsPath(p) { return '/workspaces/' + S.ws.id + p; }
  function fail(err) { toast(err.message || String(err)); }

  // ------------------------------------------------------------------------------------------
  // Auth
  // ------------------------------------------------------------------------------------------
  function logout() {
    localStorage.removeItem(TOKEN_KEY);
    S.token = '';
    if (S.socket) try { S.socket.close(); } catch (e) { /* ignore */ }
    renderLogin();
  }

  function renderLogin(message) {
    clear(app);
    var input = h('input', { type: 'password', placeholder: 'Admin or agent token', autocomplete: 'current-password', required: true });
    var form = h('form', {
      onsubmit: function (e) {
        e.preventDefault();
        S.token = input.value.trim();
        localStorage.setItem(TOKEN_KEY, S.token);
        boot();
      }
    },
      h('h1', { text: 'AWebChatbot inbox' }),
      h('p', { class: 'muted', text: 'Sign in with the ADMIN_TOKEN secret or an agent token created under Team.' }),
      message ? h('p', { style: 'color:var(--bad)', text: message }) : null,
      input,
      h('button', { class: 'btn primary', type: 'submit', text: 'Sign in' })
    );
    append(app, h('div', { class: 'login' }, form));
    input.focus();
  }

  function boot() {
    if (!S.token) return renderLogin();
    Promise.all([api('/me'), api('/workspaces'), api('/agents').catch(function () { return { agents: [] }; })])
      .then(function (r) {
        S.me = r[0];
        S.workspaces = r[1].workspaces;
        S.agents = r[2].agents;
        if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
        window.addEventListener('hashchange', route);
        route();
      })
      .catch(function (err) { renderLogin(err.message); });
  }

  // ------------------------------------------------------------------------------------------
  // Routing: #/<workspaceId>/<view>[/<id>]
  // ------------------------------------------------------------------------------------------
  function route() {
    var parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    var wsId = parts[0] || localStorage.getItem(WS_KEY) || (S.workspaces[0] && S.workspaces[0].id);
    if (!S.workspaces.length) return renderNoWorkspace();
    var ws = S.workspaces.filter(function (w) { return w.id === wsId; })[0] || S.workspaces[0];
    var view = parts[1] || 'inbox';
    var convId = null;
    if (view === 'c') { view = 'inbox'; convId = parts[2] || null; }
    var wsChanged = !S.ws || S.ws.id !== ws.id;
    S.ws = ws;
    localStorage.setItem(WS_KEY, ws.id);
    S.route = { view: view, convId: convId };
    if (wsChanged) connectSocket();
    renderShell();
  }
  function go(view, id) {
    location.hash = '#/' + S.ws.id + (view === 'inbox' ? (id ? '/c/' + id : '') : '/' + view);
  }

  function renderNoWorkspace() {
    clear(app);
    var url = h('input', { placeholder: 'https://yourwebsite.com', required: true });
    var name = h('input', { placeholder: 'Name (optional)' });
    append(app, h('div', { class: 'login' }, h('form', {
      onsubmit: function (e) {
        e.preventDefault();
        api('/workspaces', { method: 'POST', json: { url: url.value, name: name.value || undefined } }).then(function (r) {
          S.workspaces = [r.workspace];
          location.hash = '#/' + r.workspace.id + '/settings';
          route();
        }).catch(fail);
      }
    }, h('h1', { text: 'Add your first website' }), h('p', { class: 'muted', text: 'Creates a chatbot, crawls the site and gives you the install snippet.' }), url, name, h('button', { class: 'btn primary', text: 'Create chatbot' }))));
  }

  // ------------------------------------------------------------------------------------------
  // Shell
  // ------------------------------------------------------------------------------------------
  var ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

  function renderShell() {
    clear(app);
    var select = h('select', {
      'aria-label': 'Workspace',
      onchange: function () { location.hash = '#/' + select.value; }
    });
    S.workspaces.forEach(function (w) {
      append(select, h('option', { value: w.id, text: w.name + ' · ' + w.domain, selected: w.id === S.ws.id }));
    });
    var tabs = [['inbox', 'Inbox'], ['stats', 'Stats'], ['kb', 'Knowledge'], ['flows', 'Flows'], ['settings', 'Settings'], ['team', 'Team']];
    var nav = h('nav', { class: 'tabs' }, tabs.map(function (t) {
      return h('a', { href: '#/' + S.ws.id + (t[0] === 'inbox' ? '' : '/' + t[0]), class: S.route.view === t[0] ? 'on' : '', text: t[1] });
    }));
    var presence = h('span', { class: 'presence', id: 'presence' });
    var top = h('header', { class: 'top' },
      h('div', { class: 'brand', html: ICON + '<span>AWebChatbot</span>' }),
      select, nav, h('div', { class: 'spacer' }), presence,
      h('span', { class: 'muted', text: S.me.agentName }),
      h('button', { class: 'btn small', text: 'Sign out', onclick: logout })
    );
    var main = h('main', { class: 'main', id: 'main' });
    append(app, h('div', { class: 'shell' }, top, main));
    renderPresence();
    var views = { inbox: renderInbox, stats: renderStats, kb: renderKb, flows: renderFlows, settings: renderSettings, team: renderTeam };
    (views[S.route.view] || renderInbox)(main);
  }

  function renderPresence() {
    var el = document.getElementById('presence');
    if (!el) return;
    clear(el);
    var online = S.socket && S.socket.readyState === 1;
    append(el, h('span', { class: 'dot' + (online ? ' on' : '') }),
      online ? (S.presence.agents.length + ' agent' + (S.presence.agents.length === 1 ? '' : 's') + ' online') : 'offline');
  }

  // ------------------------------------------------------------------------------------------
  // Realtime
  // ------------------------------------------------------------------------------------------
  function connectSocket() {
    if (S.socket) {
      S.socket.onclose = null;
      try { S.socket.close(); } catch (e) { /* ignore */ }
    }
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var sock = new WebSocket(proto + '//' + location.host + '/admin/ws?workspace=' + encodeURIComponent(S.ws.id) + '&token=' + encodeURIComponent(S.token));
    S.socket = sock;
    var ping;
    sock.onopen = function () {
      S.socketRetry = 0;
      renderPresence();
      ping = setInterval(function () { if (sock.readyState === 1) sock.send('{"type":"ping"}'); }, 25000);
    };
    sock.onmessage = function (ev) {
      var d;
      try { d = JSON.parse(ev.data); } catch (e) { return; }
      onEvent(d);
    };
    sock.onclose = function () {
      clearInterval(ping);
      renderPresence();
      var delay = Math.min(30000, 1000 * Math.pow(2, S.socketRetry++));
      setTimeout(function () { if (S.socket === sock) connectSocket(); }, delay);
    };
  }

  function notify(title, body, convId) {
    if (document.hasFocus() && S.route.convId === convId) return;
    try {
      var ctx = new (window.AudioContext || window.webkitAudioContext)();
      var o = ctx.createOscillator();
      var g = ctx.createGain();
      o.frequency.value = 880;
      g.gain.value = 0.05;
      o.connect(g); g.connect(ctx.destination);
      o.start(); o.stop(ctx.currentTime + 0.15);
    } catch (e) { /* audio blocked */ }
    if ('Notification' in window && Notification.permission === 'granted') {
      var n = new Notification(title, { body: body, tag: convId });
      n.onclick = function () { window.focus(); go('inbox', convId); };
    }
  }

  function onEvent(d) {
    if (d.type === 'hello' || d.type === 'presence') {
      S.presence = d.presence;
      renderPresence();
      return;
    }
    if (d.type === 'message') {
      var c = S.conversations.filter(function (x) { return x.id === d.conversationId; })[0];
      if (c && !(d.message.meta && d.message.meta.note)) {
        c.last_message_preview = d.preview || d.message.content;
        c.last_message_at = d.message.createdAt;
        c.message_count++;
      }
      if (S.thread && S.thread.conversation.id === d.conversationId) {
        if (!S.thread.messages.some(function (m) { return m.id === d.message.id; })) {
          S.thread.messages.push(d.message);
          renderMessages();
        }
        if (d.message.role === 'visitor') setTyping('');
      }
      if (d.message.role === 'visitor' && c && c.mode === 'human') notify('New message', d.message.content, d.conversationId);
      if (!c) loadConversations();
      else renderList();
      return;
    }
    if (d.type === 'conversation.handoff') {
      notify('Visitor wants a human', (d.customer && (d.customer.name || d.customer.email)) || d.conversation.last_message_preview || '', d.conversation.id);
    }
    if (d.type === 'conversation.created' || d.type === 'conversation.handoff' || d.type === 'conversation.updated') {
      loadConversations();
      if (S.thread && d.conversation && S.thread.conversation.id === d.conversation.id) loadThread(d.conversation.id);
      return;
    }
    if (d.type === 'customer.updated' && S.thread && S.thread.conversation.id === d.conversationId) {
      loadThread(d.conversationId);
      return;
    }
    if (d.type === 'typing' && d.role === 'visitor') setTyping('Visitor is typing…');
  }

  function setTyping(text) {
    var el = document.getElementById('typing');
    if (!el) return;
    el.textContent = text;
    clearTimeout(S.typingTimer);
    if (text) S.typingTimer = setTimeout(function () { el.textContent = ''; }, 4000);
  }

  // ------------------------------------------------------------------------------------------
  // Inbox
  // ------------------------------------------------------------------------------------------
  var listEl, threadEl, sideEl, inboxEl;

  function renderInbox(main) {
    inboxEl = h('div', { class: 'inbox' + (S.route.convId ? ' has-thread' : '') });
    var search = h('input', {
      type: 'search', placeholder: 'Search messages, names, emails…', value: S.filter.q,
      onkeydown: function (e) { if (e.key === 'Enter') { S.filter.q = search.value.trim(); loadConversations(); } }
    });
    var chips = [
      ['Open', { status: 'open', assignee: '', mode: '' }],
      ['Needs human', { status: 'open', assignee: '', mode: 'human' }],
      ['Unassigned', { status: 'open', assignee: 'unassigned', mode: 'human' }],
      ['Mine', { status: 'open', assignee: 'me', mode: '' }],
      ['Closed', { status: 'closed', assignee: '', mode: '' }],
      ['All', { status: 'all', assignee: '', mode: '' }]
    ];
    var chipBox = h('div', { class: 'chips' }, chips.map(function (c) {
      var on = S.filter.status === c[1].status && S.filter.assignee === c[1].assignee && S.filter.mode === c[1].mode;
      return h('button', {
        class: 'chip' + (on ? ' on' : ''), text: c[0],
        onclick: function () {
          S.filter.status = c[1].status; S.filter.assignee = c[1].assignee; S.filter.mode = c[1].mode;
          renderShell();
        }
      });
    }));
    listEl = h('div', { class: 'list' });
    threadEl = h('section', { class: 'col thread' });
    sideEl = h('aside', { class: 'col side' });
    append(inboxEl, h('section', { class: 'col listcol' }, h('div', { class: 'filters' }, search, chipBox), listEl), threadEl, sideEl);
    append(main, inboxEl);
    loadConversations();
    if (S.route.convId) loadThread(S.route.convId);
    else renderEmptyThread();
  }

  function loadConversations() {
    if (!listEl) return;
    var f = S.filter;
    var qs = '?status=' + f.status + '&limit=100' + (f.assignee ? '&assignee=' + f.assignee : '') + (f.mode ? '&mode=' + f.mode : '') + (f.q ? '&q=' + encodeURIComponent(f.q) : '');
    api(wsPath('/conversations' + qs)).then(function (r) {
      S.conversations = r.conversations;
      renderList();
    }).catch(fail);
  }

  function renderList() {
    if (!listEl || !document.body.contains(listEl)) return;
    clear(listEl);
    if (!S.conversations.length) return append(listEl, h('div', { class: 'empty', text: 'No conversations here.' }));
    S.conversations.forEach(function (c) {
      var urgent = c.mode === 'human' && c.status === 'open' && !c.first_response_at;
      append(listEl, h('div', {
        class: 'item' + (S.route.convId === c.id ? ' on' : '') + (urgent ? ' urgent' : ''),
        onclick: function () { go('inbox', c.id); }
      },
        h('div', { class: 'row' },
          h('span', { class: 'name', text: c.customer_name || c.customer_email || 'Visitor ' + c.customer_id.slice(-5) }),
          h('span', { class: 'pill ' + (c.status === 'closed' ? 'closed' : c.mode), text: c.status === 'closed' ? 'closed' : c.mode }),
          h('span', { class: 'time', text: ago(c.last_message_at) })
        ),
        h('div', { class: 'prev', text: c.last_message_preview || c.subject || '' }),
        c.assignee_name ? h('div', { class: 'muted', style: 'font-size:12px', text: '→ ' + c.assignee_name }) : null
      ));
    });
  }

  function renderEmptyThread() {
    clear(threadEl);
    clear(sideEl);
    append(threadEl, h('div', { class: 'empty', text: 'Select a conversation' }));
  }

  function loadThread(id) {
    api('/conversations/' + id).then(function (r) {
      S.thread = r;
      renderThread();
      renderList();
    }).catch(function (err) { fail(err); renderEmptyThread(); });
  }

  var msgsEl, composerEl;

  function renderThread() {
    if (!threadEl) return;
    var t = S.thread;
    var c = t.conversation;
    clear(threadEl);
    var assign = h('select', {
      'aria-label': 'Assignee',
      onchange: function () {
        api('/conversations/' + c.id + '/assign', { method: 'POST', json: { agent_id: assign.value || null } }).then(function () { loadThread(c.id); loadConversations(); }).catch(fail);
      }
    }, h('option', { value: '', text: 'Unassigned' }), S.agents.map(function (a) {
      return h('option', { value: a.id, text: a.name, selected: c.assignee_id === a.id });
    }));
    var actions = [
      h('button', { class: 'btn small back', text: '←', onclick: function () { location.hash = '#/' + S.ws.id; } }),
      h('span', { class: 'title', text: (t.customer && (t.customer.name || t.customer.email)) || 'Visitor' }),
      h('span', { class: 'pill ' + (c.status === 'closed' ? 'closed' : c.mode), text: c.status === 'closed' ? 'closed' : c.mode }),
      t.visitorOnline ? h('span', { class: 'pill ok', text: 'online' }) : null,
      assign,
      S.me.agentId ? h('button', { class: 'btn small', text: 'Assign to me', onclick: function () {
        api('/conversations/' + c.id + '/assign', { method: 'POST', json: { me: true } }).then(function () { loadThread(c.id); loadConversations(); }).catch(fail);
      } }) : null,
      c.mode === 'human' && c.status === 'open' ? h('button', { class: 'btn small', text: 'Return to bot', onclick: function () {
        api('/conversations/' + c.id + '/return-to-bot', { method: 'POST', json: {} }).then(function () { loadThread(c.id); }).catch(fail);
      } }) : null,
      c.status === 'open'
        ? h('button', { class: 'btn small', text: 'Close', onclick: function () {
          api('/conversations/' + c.id + '/close', { method: 'POST', json: {} }).then(function () { loadThread(c.id); loadConversations(); }).catch(fail);
        } })
        : h('button', { class: 'btn small', text: 'Reopen', onclick: function () {
          api('/conversations/' + c.id + '/reopen', { method: 'POST', json: {} }).then(function () { loadThread(c.id); loadConversations(); }).catch(fail);
        } })
    ];
    msgsEl = h('div', { class: 'msgs' });
    var textarea = h('textarea', {
      placeholder: 'Reply to the customer… (Ctrl/⌘+Enter to send)',
      onkeydown: function (e) { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendReply(); } },
      oninput: function () {
        if (S.noteMode || Date.now() - S.lastTyping < 3000) return;
        S.lastTyping = Date.now();
        api('/conversations/' + c.id + '/typing', { method: 'POST', json: {} }).catch(function () {});
      }
    });
    var noteToggle = h('label', { class: 'row-flex muted', style: 'font-size:13px' },
      h('input', { type: 'checkbox', onchange: function (e) { S.noteMode = e.target.checked; composerEl.classList.toggle('note', S.noteMode); sendBtn.textContent = S.noteMode ? 'Add note' : 'Send'; } }),
      'Internal note');
    var sendBtn = h('button', { class: 'btn primary', text: 'Send', onclick: sendReply });
    var suggestBtn = h('button', {
      class: 'btn', text: '✨ AI draft', onclick: function () {
        suggestBtn.disabled = true;
        suggestBtn.textContent = 'Drafting…';
        api('/conversations/' + c.id + '/suggest-reply', { method: 'POST', json: {} }).then(function (r) {
          textarea.value = r.draft;
          textarea.focus();
        }).catch(fail).finally(function () { suggestBtn.disabled = false; suggestBtn.textContent = '✨ AI draft'; });
      }
    });
    composerEl = h('div', { class: 'composer' + (S.noteMode ? ' note' : '') }, textarea, h('div', { class: 'bar' }, sendBtn, suggestBtn, noteToggle));
    S.noteMode = false;

    function sendReply() {
      var text = textarea.value.trim();
      if (!text) return;
      sendBtn.disabled = true;
      var path = S.noteMode ? '/note' : '/reply';
      api('/conversations/' + c.id + path, { method: 'POST', json: { content: text } }).then(function (r) {
        textarea.value = '';
        if (!S.thread.messages.some(function (m) { return m.id === r.message.id; })) {
          S.thread.messages.push(r.message);
          renderMessages();
        }
        loadConversations();
      }).catch(fail).finally(function () { sendBtn.disabled = false; });
    }

    append(threadEl, h('div', { class: 'thead' }, actions), msgsEl, h('div', { class: 'typing-ind', id: 'typing' }), composerEl);
    renderMessages();
    renderSide();
    inboxEl.classList.add('has-thread');
  }

  function renderMessages() {
    if (!msgsEl) return;
    clear(msgsEl);
    S.thread.messages.forEach(function (m) {
      var isNote = m.meta && m.meta.note;
      var cls = 'm ' + (isNote ? 'note' : m.role);
      if (m.role === 'system' && !isNote) return append(msgsEl, h('div', { class: cls, text: m.content + ' · ' + fmt(m.createdAt) }));
      var who = isNote ? '📝 Note · ' + (m.authorName || 'Agent') : m.role === 'visitor' ? 'Visitor' : m.role === 'bot' ? 'Bot' + (m.meta && m.meta.provider ? ' · ' + m.meta.provider : '') : (m.authorName || 'Agent');
      var bubble = h('div', { class: 'bubble', html: linkify(m.content) });
      (m.attachments || []).forEach(function (a) {
        if (/^image\//.test(a.type)) append(bubble, h('a', { href: /^\/v1\/files\//.test(a.url) ? a.url : '#', target: '_blank' }, h('img', { src: /^\/v1\/files\//.test(a.url) ? a.url : '', alt: a.name })));
        else append(bubble, h('div', {}, h('a', { href: /^\/v1\/files\//.test(a.url) ? a.url : '#', target: '_blank', text: '📎 ' + a.name })));
      });
      var sources = (m.meta && m.meta.sources) || [];
      append(msgsEl, h('div', { class: cls },
        h('div', { class: 'meta', text: who + ' · ' + new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }),
        bubble,
        m.buttons && m.buttons.length ? h('div', { class: 'btnrow' }, m.buttons.map(function (b) { return h('span', { class: 'pill', text: b }); })) : null,
        sources.length ? h('div', { class: 'srcs' }, 'Sources: ', sources.map(function (s, i) {
          return [i ? ', ' : '', h('a', { href: safeHref(s.url), target: '_blank', rel: 'noopener', text: s.title })];
        })) : null
      ));
    });
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  function renderSide() {
    clear(sideEl);
    var t = S.thread;
    var c = t.conversation;
    var cu = t.customer || {};
    var attrs = cu.attributes || {};
    var meta = c.meta || {};
    var pairs = [
      ['Name', cu.name || '—'], ['Email', cu.email || '—'], ['Phone', cu.phone || '—'],
      ['Location', [meta.city, meta.country].filter(Boolean).join(', ') || '—'],
      ['Page', c.page_url ? h('a', { href: safeHref(c.page_url), target: '_blank', rel: 'noopener', text: c.page_url.replace(/^https?:\/\//, '') }) : '—'],
      ['Started', fmt(c.created_at)], ['Rating', c.rating ? '★'.repeat(c.rating) : '—']
    ];
    Object.keys(attrs).forEach(function (k) { pairs.push([k, String(attrs[k])]); });
    var kv = h('div', { class: 'kv' }, pairs.map(function (p) { return [h('div', {}, p[0]), h('div', {}, p[1])]; }));
    var summaryBox = h('div', { class: 'summary', text: meta.summary || 'No summary yet.' });
    var sumBtn = h('button', { class: 'btn small', text: 'Summarize', onclick: function () {
      sumBtn.disabled = true;
      api('/conversations/' + c.id + '/summarize', { method: 'POST', json: {} }).then(function (r) { summaryBox.textContent = r.summary; }).catch(fail).finally(function () { sumBtn.disabled = false; });
    } });
    var history = h('div', {}, h('span', { class: 'muted', text: 'Loading…' }));
    if (cu.id) {
      api('/customers/' + cu.id).then(function (r) {
        clear(history);
        r.conversations.forEach(function (x) {
          append(history, h('div', { class: 'item' + (x.id === c.id ? ' on' : ''), onclick: function () { go('inbox', x.id); } },
            h('div', { class: 'row' }, h('span', { class: 'name', text: x.subject || '(no subject)' }), h('span', { class: 'time', text: ago(x.last_message_at) })),
            h('div', { class: 'prev', text: x.status + ' · ' + x.message_count + ' messages' })));
        });
      }).catch(function () { clear(history); });
    }
    var exportBtn = h('button', { class: 'btn small', text: 'Copy transcript', onclick: function () {
      api('/conversations/' + c.id + '/transcript').then(function (r) {
        return navigator.clipboard.writeText(r.markdown);
      }).then(function () { toast('Transcript copied'); }).catch(fail);
    } });
    append(sideEl,
      h('div', {}, h('h4', { text: 'Customer' }), kv),
      h('div', {}, h('div', { class: 'row-flex', style: 'justify-content:space-between' }, h('h4', { text: 'AI summary' }), sumBtn), summaryBox),
      h('div', {}, h('h4', { text: 'Conversations' }), history),
      h('div', {}, exportBtn)
    );
  }

  // ------------------------------------------------------------------------------------------
  // Stats
  // ------------------------------------------------------------------------------------------
  function renderStats(main) {
    var page = h('div', { class: 'page' }, h('h2', { text: 'Stats · ' + S.ws.name }));
    append(main, page);
    var days = h('select', { onchange: function () { load(); } },
      [7, 30, 90].map(function (d) { return h('option', { value: d, text: 'Last ' + d + ' days' }); }));
    var body = h('div', {});
    append(page, h('div', { class: 'row-flex', style: 'margin-bottom:14px' }, days), body);
    function card(v, l) { return h('div', { class: 'card' }, h('div', { class: 'v', text: v === null || v === undefined ? '—' : String(v) }), h('div', { class: 'l', text: l })); }
    function load() {
      api(wsPath('/stats?days=' + days.value)).then(function (s) {
        clear(body);
        append(body,
          h('div', { class: 'cards' },
            card(s.conversations, 'Conversations'), card(s.open_now, 'Open now'), card(s.unassigned_now, 'Unassigned (human)'),
            card(s.handoff_rate + '%', 'Handoff rate'), card(s.bot_resolution_rate + '%', 'Resolved by bot'),
            card(s.avg_first_response_minutes === null ? null : s.avg_first_response_minutes + ' min', 'Avg first response'),
            card(s.avg_resolution_minutes === null ? null : s.avg_resolution_minutes + ' min', 'Avg resolution'),
            card(s.csat_avg === null ? null : s.csat_avg + ' / 5', 'CSAT (' + s.csat_responses + ')')
          ),
          h('h3', { text: 'Daily volume' }), h('div', { class: 'box' }, chart(s.daily)),
          h('h3', { text: 'Top pages' }), table(['Page', 'Conversations'], s.top_pages.map(function (p) { return [p.page_url, p.conversations]; })),
          h('h3', { text: 'AI usage' }), table(['Provider', 'Model', 'Requests', 'Input tokens', 'Output tokens'], s.ai_usage.map(function (u) {
            return [u.provider, u.model, u.requests, u.input_tokens, u.output_tokens];
          }))
        );
      }).catch(fail);
    }
    load();
  }

  function chart(daily) {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'chart');
    svg.setAttribute('viewBox', '0 0 600 160');
    svg.setAttribute('preserveAspectRatio', 'none');
    if (!daily.length) {
      var t = document.createElementNS(ns, 'text');
      t.setAttribute('x', '10'); t.setAttribute('y', '80'); t.textContent = 'No data yet';
      svg.appendChild(t);
      return svg;
    }
    var max = Math.max.apply(null, daily.map(function (d) { return d.conversations; })) || 1;
    var w = 600 / daily.length;
    daily.forEach(function (d, i) {
      var hgt = (d.conversations / max) * 130;
      var r = document.createElementNS(ns, 'rect');
      r.setAttribute('class', 'c'); r.setAttribute('x', String(i * w + 2)); r.setAttribute('width', String(Math.max(1, w - 4)));
      r.setAttribute('y', String(140 - hgt)); r.setAttribute('height', String(hgt)); r.setAttribute('rx', '2');
      var title = document.createElementNS(ns, 'title');
      title.textContent = d.day + ': ' + d.conversations + ' conversations, ' + d.handoffs + ' handoffs';
      r.appendChild(title);
      svg.appendChild(r);
      var hh = (d.handoffs / max) * 130;
      var r2 = document.createElementNS(ns, 'rect');
      r2.setAttribute('class', 'h'); r2.setAttribute('x', String(i * w + 2)); r2.setAttribute('width', String(Math.max(1, w - 4)));
      r2.setAttribute('y', String(140 - hh)); r2.setAttribute('height', String(hh));
      svg.appendChild(r2);
      if (daily.length <= 31 && (i % Math.ceil(daily.length / 8) === 0)) {
        var tx = document.createElementNS(ns, 'text');
        tx.setAttribute('x', String(i * w + 2)); tx.setAttribute('y', '156'); tx.textContent = d.day.slice(5);
        svg.appendChild(tx);
      }
    });
    return svg;
  }

  function table(headers, rows) {
    if (!rows.length) return h('div', { class: 'muted', text: 'Nothing yet.' });
    return h('table', {}, h('thead', {}, h('tr', {}, headers.map(function (x) { return h('th', { text: x }); }))),
      h('tbody', {}, rows.map(function (r) { return h('tr', {}, r.map(function (cell) { return h('td', {}, cell instanceof Node ? cell : String(cell == null ? '' : cell)); })); })));
  }

  // ------------------------------------------------------------------------------------------
  // Knowledge base
  // ------------------------------------------------------------------------------------------
  function renderKb(main) {
    var page = h('div', { class: 'page' }, h('h2', { text: 'Knowledge · ' + S.ws.name }));
    append(main, page);

    var q = h('input', { type: 'search', placeholder: 'Search what the bot knows…', style: 'flex:1' });
    var results = h('div', {});
    var testQ = h('input', { placeholder: 'Ask the bot a test question…', style: 'flex:1' });
    var testOut = h('div', {});
    append(page, h('div', { class: 'grid2' },
      h('div', { class: 'box' }, h('div', { class: 'row-flex' }, q, h('button', { class: 'btn', text: 'Search', onclick: search })), results),
      h('div', { class: 'box' }, h('div', { class: 'row-flex' }, testQ, h('button', { class: 'btn primary', text: 'Ask', onclick: ask })), testOut)
    ));
    q.addEventListener('keydown', function (e) { if (e.key === 'Enter') search(); });
    testQ.addEventListener('keydown', function (e) { if (e.key === 'Enter') ask(); });
    function search() {
      if (!q.value.trim()) return;
      api(wsPath('/kb/search?q=' + encodeURIComponent(q.value))).then(function (r) {
        clear(results);
        if (!r.results.length) return append(results, h('p', { class: 'muted', text: 'No matches.' }));
        r.results.forEach(function (hit) {
          append(results, h('div', { style: 'margin-top:10px' }, h('a', { href: safeHref(hit.url), target: '_blank', rel: 'noopener', text: hit.title }),
            h('span', { class: 'muted', text: ' · score ' + hit.score }), h('div', { class: 'muted', style: 'font-size:13px;white-space:pre-wrap', text: hit.content.slice(0, 400) })));
        });
      }).catch(fail);
    }
    function ask() {
      if (!testQ.value.trim()) return;
      clear(testOut);
      append(testOut, h('p', { class: 'muted', text: 'Thinking…' }));
      api(wsPath('/test-chat'), { method: 'POST', json: { question: testQ.value } }).then(function (r) {
        clear(testOut);
        append(testOut, h('div', { class: 'summary', style: 'margin-top:10px', html: linkify(r.answer) }),
          h('p', { class: 'muted', style: 'font-size:12px', text: 'via ' + r.provider + ' (' + r.model + ')' + (r.wouldHandoff ? ' · would hand off to a human' : '') + ' · ' + r.sources.length + ' sources' }));
      }).catch(function (err) { clear(testOut); fail(err); });
    }

    // Crawl
    var crawlUrl = h('input', { value: 'https://' + S.ws.domain + '/', style: 'flex:1' });
    var maxPages = h('input', { type: 'number', value: '150', min: '1', max: '5000', style: 'width:90px' });
    var crawls = h('div', {});
    append(page, h('h3', { text: 'Crawl website' }), h('div', { class: 'box' },
      h('div', { class: 'row-flex' }, crawlUrl, maxPages, h('button', { class: 'btn primary', text: 'Start crawl', onclick: function () {
        api(wsPath('/crawl'), { method: 'POST', json: { url: crawlUrl.value, maxPages: Number(maxPages.value) } }).then(function () { toast('Crawl started'); loadCrawls(); }).catch(fail);
      } })), crawls));
    function loadCrawls() {
      api(wsPath('/crawl')).then(function (r) {
        clear(crawls);
        append(crawls, h('div', { style: 'margin-top:10px' }, table(['Started', 'URL', 'Status', 'Done', 'Failed', 'Queued'], r.crawls.map(function (c) {
          return [fmt(c.created_at), c.root_url, c.status, c.pages_done, c.pages_failed, c.pages_queued];
        }))));
      }).catch(fail);
    }
    loadCrawls();

    // Manual document
    var title = h('input', { placeholder: 'Title, e.g. Refund policy' });
    var url = h('input', { placeholder: 'Source URL (optional)' });
    var content = h('textarea', { rows: '6', placeholder: 'Content the bot should know (FAQ answers, policies, product facts)…' });
    append(page, h('h3', { text: 'Add knowledge manually' }), h('div', { class: 'box' },
      h('div', { class: 'grid2' }, title, url), h('div', { style: 'height:8px' }), content, h('div', { style: 'height:8px' }),
      h('button', { class: 'btn primary', text: 'Add to knowledge base', onclick: function () {
        api(wsPath('/kb/documents'), { method: 'POST', json: { title: title.value, url: url.value || undefined, content: content.value } }).then(function () {
          title.value = ''; url.value = ''; content.value = '';
          toast('Added'); loadDocs();
        }).catch(fail);
      } })));

    var docs = h('div', {});
    append(page, h('h3', { text: 'Indexed documents' }), docs);
    function loadDocs() {
      api(wsPath('/kb/documents?limit=300')).then(function (r) {
        clear(docs);
        append(docs, h('p', { class: 'muted', text: r.total + ' documents' }), table(['Title', 'Source', 'Chunks', 'Semantic', 'Updated', ''], r.documents.map(function (d) {
          return [
            h('a', { href: safeHref(d.url), target: '_blank', rel: 'noopener', text: d.title || d.url }),
            d.source, d.chunk_count, d.vector_indexed ? 'yes' : 'keyword only', fmt(d.updated_at),
            h('button', { class: 'btn small danger', text: 'Delete', onclick: function () {
              if (!confirm('Delete "' + (d.title || d.url) + '" from the knowledge base?')) return;
              api(wsPath('/kb/documents/' + d.id), { method: 'DELETE' }).then(loadDocs).catch(fail);
            } })
          ];
        })));
      }).catch(fail);
    }
    loadDocs();
  }

  // ------------------------------------------------------------------------------------------
  // Flows
  // ------------------------------------------------------------------------------------------
  function renderFlows(main) {
    var page = h('div', { class: 'page' });
    append(main, page);
    var list = h('div', {});
    var editor = h('div', {});
    var name = h('input', { placeholder: 'New flow name' });
    append(page, h('h2', { text: 'Chatbot flows · ' + S.ws.name }),
      h('p', { class: 'muted', text: 'A published flow runs when a visitor opens the chat: welcome messages, questions, button menus, then AI answers or a handoff to your team. Only one flow can be live.' }),
      h('div', { class: 'row-flex', style: 'margin-bottom:12px' }, name, h('button', { class: 'btn primary', text: 'Create flow', onclick: function () {
        api(wsPath('/scenarios'), { method: 'POST', json: { name: name.value || 'New flow' } }).then(function (r) { name.value = ''; loadList(); openFlow(r.scenario.id); }).catch(fail);
      } })), list, editor);

    function loadList() {
      api(wsPath('/scenarios')).then(function (r) {
        clear(list);
        append(list, table(['Name', 'Status', 'Steps', 'Updated', ''], r.scenarios.map(function (s) {
          return [s.name, h('span', { class: 'pill' + (s.status === 'active' ? ' ok' : ''), text: s.status }), s.step_count, fmt(s.updated_at),
            h('button', { class: 'btn small', text: 'Edit', onclick: function () { openFlow(s.id); } })];
        })));
      }).catch(fail);
    }

    function openFlow(id) {
      api(wsPath('/scenarios/' + id)).then(function (r) { drawEditor(r.scenario, r.problems); }).catch(fail);
    }

    function drawEditor(sc, problems) {
      clear(editor);
      var steps = sc.steps;
      var label = function (stepId) {
        var idx = steps.findIndex(function (s) { return s.id === stepId; });
        return idx < 0 ? '—' : '#' + (idx + 1) + ' ' + steps[idx].type;
      };
      var rename = h('input', { value: sc.name });
      append(editor, h('h3', { text: 'Editing: ' + sc.name }),
        h('div', { class: 'row-flex', style: 'margin-bottom:10px' }, rename,
          h('button', { class: 'btn', text: 'Rename', onclick: function () {
            api(wsPath('/scenarios/' + sc.id), { method: 'PATCH', json: { name: rename.value } }).then(function () { loadList(); openFlow(sc.id); }).catch(fail);
          } }),
          sc.status === 'active'
            ? h('button', { class: 'btn', text: 'Unpublish', onclick: function () { api(wsPath('/scenarios/' + sc.id + '/deactivate'), { method: 'POST', json: {} }).then(function () { loadList(); openFlow(sc.id); }).catch(fail); } })
            : h('button', { class: 'btn primary', text: 'Publish', onclick: function () { api(wsPath('/scenarios/' + sc.id + '/activate'), { method: 'POST', json: {} }).then(function () { toast('Flow is live'); loadList(); openFlow(sc.id); }).catch(fail); } }),
          h('button', { class: 'btn danger', text: 'Delete flow', onclick: function () {
            if (!confirm('Delete this flow?')) return;
            api(wsPath('/scenarios/' + sc.id), { method: 'DELETE' }).then(function () { clear(editor); loadList(); }).catch(fail);
          } })),
        problems.length ? h('div', { class: 'box', style: 'border-color:var(--warn)' }, problems.map(function (p) { return h('div', { text: '⚠ ' + p }); })) : null
      );
      steps.forEach(function (s, i) {
        var content = h('textarea', { rows: '2', value: s.content, style: 'width:100%' });
        var cfg = h('textarea', { rows: '3', class: 'mono', value: JSON.stringify(s.config, null, 2), style: 'width:100%' });
        var links = [];
        if (s.config.next_step_id) links.push('next → ' + label(s.config.next_step_id));
        (s.config.options || []).forEach(function (o) { links.push('"' + o.label + '" → ' + (o.next_step_id ? label(o.next_step_id) : 'step next / AI')); });
        append(editor, h('div', { class: 'step' + (sc.start_step_id === s.id ? ' start' : '') },
          h('div', { class: 'hdr' }, h('strong', { text: '#' + (i + 1) }), h('span', { class: 'pill', text: s.type }), h('span', { class: 'mono muted', text: s.id }),
            sc.start_step_id === s.id ? h('span', { class: 'pill ok', text: 'start' }) : h('button', { class: 'btn small', text: 'Make start', onclick: function () {
              api(wsPath('/scenarios/' + sc.id + '/start'), { method: 'POST', json: { step_id: s.id } }).then(function () { openFlow(sc.id); }).catch(fail);
            } }),
            h('div', { class: 'spacer' }),
            h('button', { class: 'btn small', text: 'Save', onclick: function () {
              var parsed;
              try { parsed = JSON.parse(cfg.value || '{}'); } catch (e) { return toast('Config is not valid JSON'); }
              api(wsPath('/scenarios/' + sc.id + '/steps/' + s.id), { method: 'PATCH', json: { content: content.value, config: parsed } }).then(function () { toast('Saved'); openFlow(sc.id); }).catch(fail);
            } }),
            h('button', { class: 'btn small danger', text: 'Delete', onclick: function () {
              api(wsPath('/scenarios/' + sc.id + '/steps/' + s.id), { method: 'DELETE' }).then(function () { openFlow(sc.id); }).catch(fail);
            } })),
          content,
          h('div', { class: 'muted', style: 'font-size:12px;margin:6px 0', text: links.join(' · ') || 'end → AI answers' }),
          h('details', {}, h('summary', { class: 'muted', style: 'font-size:12px;cursor:pointer', text: 'Advanced config (next_step_id, options, variable, validation)' }), cfg)
        ));
      });
      // Add step
      var type = h('select', {}, ['message', 'buttons', 'question', 'collect_email', 'ai', 'handoff'].map(function (t) { return h('option', { value: t, text: t }); }));
      var text = h('textarea', { rows: '2', placeholder: 'What the bot says' });
      var opts = h('input', { placeholder: 'Button labels, comma separated (for buttons)' });
      var variable = h('input', { placeholder: 'Save answer as variable (e.g. name, email, company)' });
      var after = h('select', {}, h('option', { value: '', text: 'Do not link' }), steps.map(function (s, i) { return h('option', { value: s.id, text: 'Link after #' + (i + 1) + ' ' + s.type, selected: i === steps.length - 1 }); }));
      append(editor, h('div', { class: 'box' }, h('strong', { text: 'Add step' }), h('div', { style: 'height:8px' }),
        h('div', { class: 'grid2' }, type, after), h('div', { style: 'height:8px' }), text, h('div', { style: 'height:8px' }),
        h('div', { class: 'grid2' }, opts, variable), h('div', { style: 'height:8px' }),
        h('button', { class: 'btn primary', text: 'Add step', onclick: function () {
          var config = {};
          if (type.value === 'buttons') config.options = opts.value.split(',').map(function (o) { return o.trim(); }).filter(Boolean).map(function (l) { return { label: l }; });
          if (variable.value.trim()) config.variable = variable.value.trim();
          api(wsPath('/scenarios/' + sc.id + '/steps'), { method: 'POST', json: { type: type.value, content: text.value, config: config, previous_step_id: after.value || undefined } })
            .then(function () { openFlow(sc.id); loadList(); }).catch(fail);
        } })));
    }
    loadList();
  }

  // ------------------------------------------------------------------------------------------
  // Settings
  // ------------------------------------------------------------------------------------------
  function renderSettings(main) {
    var page = h('div', { class: 'page' });
    append(main, page);
    api('/workspaces/' + S.ws.id).then(function (r) {
      var ws = r.workspace;
      var s = ws.settings;
      var f = {};
      function field(key, label, el, hint) {
        f[key] = el;
        return h('div', { class: 'field' }, h('label', { text: label }), el, hint ? h('div', { class: 'hint', text: hint }) : null);
      }
      function input(v, type) { return h('input', { value: v, type: type || 'text' }); }
      function area(v, rows) { return h('textarea', { rows: String(rows || 3), value: v }); }
      function sel(v, options) { return h('select', {}, options.map(function (o) { return h('option', { value: o, text: o, selected: o === v }); })); }
      function check(v) { return h('input', { type: 'checkbox', checked: v }); }
      var name = input(ws.name);
      var origins = area(ws.allowedOrigins.join('\n'), 3);

      append(page, h('h2', { text: 'Settings · ' + ws.name }),
        h('div', { class: 'box' }, h('div', { class: 'grid2' },
          h('div', { class: 'field' }, h('label', { text: 'Workspace name' }), name),
          field('botName', 'Bot name', input(s.botName)),
          field('brandColor', 'Brand color', input(s.brandColor, 'color')),
          field('position', 'Launcher position', sel(s.position, ['right', 'left'])),
          field('theme', 'Theme', sel(s.theme, ['auto', 'light', 'dark'])),
          field('launcherText', 'Launcher text', input(s.launcherText), 'Empty = icon only'),
          field('logoUrl', 'Logo URL', input(s.logoUrl)),
          field('placeholder', 'Input placeholder', input(s.placeholder))
        ), h('div', { style: 'height:10px' }),
          field('greeting', 'Greeting', area(s.greeting, 2)),
          field('quickReplies', 'Quick replies (one per line)', area(s.quickReplies.join('\n'), 3)),
          field('disclaimer', 'Disclaimer under the chat', input(s.disclaimer))
        ),
        h('h3', { text: 'AI' }),
        h('div', { class: 'box' }, h('div', { class: 'grid2' },
          field('provider', 'Primary provider', sel(s.provider, ['anthropic', 'gemini', 'xai', 'openai', 'workers-ai'])),
          field('model', 'Model override', input(s.model), 'Empty = provider default from wrangler.toml'),
          field('fallbacks', 'Fallback providers (comma separated)', input(s.fallbacks.join(', '))),
          field('temperature', 'Temperature', input(String(s.temperature), 'number')),
          field('maxTokens', 'Max reply tokens', input(String(s.maxTokens), 'number'))
        ), h('div', { style: 'height:10px' }),
          field('persona', 'About the business / persona', area(s.persona, 6), 'Facts and tone the bot should always know.'),
          field('guardrails', 'Guardrails (one rule per line)', area(s.guardrails.join('\n'), 5)),
          h('label', { class: 'row-flex' }, (f.showSources = check(s.showSources)), 'Show source links under answers')
        ),
        h('h3', { text: 'Human handoff & lifecycle' }),
        h('div', { class: 'box' },
          h('label', { class: 'row-flex' }, (f.handoffEnabled = check(s.handoffEnabled)), 'Allow handoff to a human'),
          h('div', { style: 'height:8px' }),
          h('div', { class: 'grid2' },
            field('handoffKeywords', 'Handoff keywords (comma separated)', input(s.handoffKeywords.join(', '))),
            field('alertEmail', 'Alert email for handoffs', input(s.alertEmail)),
            field('autoCloseHours', 'Auto-close after idle hours', input(String(s.autoCloseHours), 'number'))
          ), h('div', { style: 'height:8px' }),
          field('handoffMessage', 'Message when team is online', area(s.handoffMessage, 2)),
          field('offlineMessage', 'Message when team is offline', area(s.offlineMessage, 2)),
          h('label', { class: 'row-flex' }, (f.collectEmailBeforeChat = check(s.collectEmailBeforeChat)), 'Ask for name and email before chatting'),
          h('label', { class: 'row-flex' }, (f.emailTranscripts = check(s.emailTranscripts)), 'Email transcript to the customer when closed')
        ),
        h('h3', { text: 'Website, crawling & security' }),
        h('div', { class: 'box' }, h('div', { class: 'grid2' },
          field('sitemapUrl', 'Sitemap URL (optional)', input(s.sitemapUrl)),
          field('turnstileSiteKey', 'Cloudflare Turnstile site key', input(s.turnstileSiteKey), 'Requires TURNSTILE_SECRET on the Worker')
        ), h('div', { style: 'height:8px' }),
          h('label', { class: 'row-flex' }, (f.renderJs = check(s.renderJs)), 'Render JavaScript when crawling (Cloudflare Browser Rendering)'),
          h('label', { class: 'row-flex' }, (f.recrawlDaily = check(s.recrawlDaily)), 'Re-crawl the site daily'),
          h('label', { class: 'row-flex' }, (f.allowLocalhost = check(s.allowLocalhost)), 'Allow localhost (development)'),
          h('div', { style: 'height:8px' }),
          h('div', { class: 'field' }, h('label', { text: 'Extra allowed origins (one per line, *.domain allowed)' }), origins)
        ),
        h('button', { class: 'btn primary', text: 'Save settings', onclick: saveSettings })
      );

      function lines(el) { return el.value.split('\n').map(function (x) { return x.trim(); }).filter(Boolean); }
      function csv(el) { return el.value.split(',').map(function (x) { return x.trim(); }).filter(Boolean); }
      function saveSettings() {
        var settings = {
          botName: f.botName.value, brandColor: f.brandColor.value, position: f.position.value, theme: f.theme.value,
          launcherText: f.launcherText.value, logoUrl: f.logoUrl.value, placeholder: f.placeholder.value,
          greeting: f.greeting.value, quickReplies: lines(f.quickReplies), disclaimer: f.disclaimer.value,
          provider: f.provider.value, model: f.model.value.trim(), fallbacks: csv(f.fallbacks),
          temperature: Number(f.temperature.value), maxTokens: Number(f.maxTokens.value),
          persona: f.persona.value, guardrails: lines(f.guardrails), showSources: f.showSources.checked,
          handoffEnabled: f.handoffEnabled.checked, handoffKeywords: csv(f.handoffKeywords), alertEmail: f.alertEmail.value.trim(),
          autoCloseHours: Number(f.autoCloseHours.value), handoffMessage: f.handoffMessage.value, offlineMessage: f.offlineMessage.value,
          collectEmailBeforeChat: f.collectEmailBeforeChat.checked, emailTranscripts: f.emailTranscripts.checked,
          sitemapUrl: f.sitemapUrl.value.trim(), turnstileSiteKey: f.turnstileSiteKey.value.trim(),
          renderJs: f.renderJs.checked, recrawlDaily: f.recrawlDaily.checked, allowLocalhost: f.allowLocalhost.checked
        };
        api('/workspaces/' + ws.id, { method: 'PATCH', json: { name: name.value, settings: settings, allowedOrigins: lines(origins) } }).then(function (r2) {
          S.workspaces = S.workspaces.map(function (w) { return w.id === r2.workspace.id ? r2.workspace : w; });
          toast('Settings saved');
        }).catch(fail);
      }

      // Install code
      var platforms = ['html', 'wordpress', 'shopify', 'nextjs', 'react', 'nuxt', 'cloudflare', 'gtm'];
      var codeBox = h('div', {});
      var pick = h('select', { onchange: function () { loadCode(); } }, platforms.map(function (p) { return h('option', { value: p, text: p }); }));
      append(page, h('h3', { text: 'Install on your website' }), h('div', { class: 'box' }, h('div', { class: 'row-flex', style: 'margin-bottom:10px' }, pick,
        h('span', { class: 'muted', text: 'Widget key: ' }), h('span', { class: 'mono', text: ws.publicKey })), codeBox));
      function loadCode() {
        api('/workspaces/' + ws.id + '/install-code?platform=' + pick.value).then(function (c) {
          clear(codeBox);
          append(codeBox, h('pre', { class: 'code', text: c.snippet }), h('div', { style: 'height:8px' }),
            h('button', { class: 'btn small', text: 'Copy', onclick: function () { navigator.clipboard.writeText(c.snippet).then(function () { toast('Copied'); }); } }),
            h('ol', {}, c.steps.map(function (s) { return h('li', { text: s }); })));
        }).catch(fail);
      }
      loadCode();

      // Webhooks
      var hooks = h('div', {});
      var hookKind = h('select', {}, ['slack', 'discord', 'generic'].map(function (k) { return h('option', { value: k, text: k }); }));
      var hookUrl = h('input', { placeholder: 'https://hooks.slack.com/services/…', style: 'flex:1' });
      append(page, h('h3', { text: 'Notifications (Slack, Discord, webhooks)' }), h('div', { class: 'box' },
        h('div', { class: 'row-flex' }, hookKind, hookUrl, h('button', { class: 'btn primary', text: 'Add', onclick: function () {
          api('/workspaces/' + ws.id + '/webhooks', { method: 'POST', json: { kind: hookKind.value, url: hookUrl.value } }).then(function (r3) {
            hookUrl.value = '';
            if (r3.signing_secret) alert('Signing secret (shown once):\n\n' + r3.signing_secret);
            loadHooks();
          }).catch(fail);
        } })), hooks));
      function loadHooks() {
        api('/workspaces/' + ws.id + '/webhooks').then(function (r4) {
          clear(hooks);
          append(hooks, h('div', { style: 'margin-top:10px' }, table(['Kind', 'URL', 'Events', ''], r4.webhooks.map(function (w) {
            return [w.kind, w.url.replace(/(services\/|webhooks\/)(.{6}).*/, '$1$2…'), w.events.join(', '), h('button', { class: 'btn small danger', text: 'Remove', onclick: function () {
              api('/workspaces/' + ws.id + '/webhooks/' + w.id, { method: 'DELETE' }).then(loadHooks).catch(fail);
            } })];
          }))));
        }).catch(fail);
      }
      loadHooks();
    }).catch(fail);
  }

  // ------------------------------------------------------------------------------------------
  // Team
  // ------------------------------------------------------------------------------------------
  function renderTeam(main) {
    var page = h('div', { class: 'page' }, h('h2', { text: 'Team & platform' }));
    append(main, page);
    var agents = h('div', {});
    var providers = h('div', {});
    var nm = h('input', { placeholder: 'Name' });
    var em = h('input', { placeholder: 'Email', type: 'email' });
    var role = h('select', {}, h('option', { value: 'agent', text: 'agent' }), h('option', { value: 'admin', text: 'admin' }));
    append(page, h('div', { class: 'box' }, h('strong', { text: 'Invite an agent' }), h('div', { style: 'height:8px' }),
      h('div', { class: 'row-flex' }, nm, em, role, h('button', { class: 'btn primary', text: 'Create', onclick: function () {
        api('/agents', { method: 'POST', json: { name: nm.value, email: em.value, role: role.value } }).then(function (r) {
          nm.value = ''; em.value = '';
          prompt('Agent token (shown once). Share it securely; they sign in to /inbox with it:', r.token);
          load();
        }).catch(fail);
      } }))), agents, h('h3', { text: 'Integrations status' }), providers);
    function load() {
      api('/agents').then(function (r) {
        S.agents = r.agents;
        clear(agents);
        append(agents, table(['Name', 'Email', 'Role', 'Last seen', ''], r.agents.map(function (a) {
          return [a.name, a.email, a.role, fmt(a.last_seen_at), h('button', { class: 'btn small danger', text: 'Remove', onclick: function () {
            if (!confirm('Remove ' + a.name + '?')) return;
            api('/agents/' + a.id, { method: 'DELETE' }).then(load).catch(fail);
          } })];
        })));
      }).catch(fail);
      api('/providers').then(function (p) {
        clear(providers);
        var rows = p.providers.map(function (x) { return ['AI: ' + x.name, x.configured ? '✅ configured' : '— not set']; });
        rows.push(['Cloudflare AI Gateway', p.aiGateway ? '✅' : '—'], ['Vectorize semantic search', p.vectorize ? '✅' : '—'],
          ['Browser Rendering (JS crawl)', p.browserRendering ? '✅' : '—'], ['Turnstile', p.turnstile ? '✅' : '—'],
          ['Supabase mirror', p.supabaseMirror ? '✅' : '—'], ['Email (Resend)', p.email ? '✅' : '—']);
        append(providers, table(['Integration', 'Status'], rows));
      }).catch(fail);
    }
    load();
  }

  boot();
})();
