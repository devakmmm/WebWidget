(function () {
  'use strict';

  function qs(sel, root = document) { return root.querySelector(sel); }
  function esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }
  function nowTime(ts) {
    const d = ts ? new Date(ts) : new Date();
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  const script = document.currentScript;
  const site = script?.dataset?.site?.trim() || 'default';
  const baseOrigin = script?.src ? new URL(script.src).origin : window.location.origin;

  // Inject CSS
  const cssHref = new URL('/widget.css', baseOrigin).toString();
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = cssHref;
  document.head.appendChild(link);

  // Chat Bubble
  const bubble = document.createElement('div');
  bubble.className = 'wsx-bubble';
  bubble.innerHTML = '<div class="wsx-dot" id="wsxDot"></div><svg class="wsx-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>';
  bubble.style.cssText = 'pointer-events:auto;z-index:2147483647';
  document.body.appendChild(bubble);

  // Chat Panel
  const panel = document.createElement('div');
  panel.className = 'wsx-panel wsx-hidden';
  panel.style.cssText = 'pointer-events:auto;z-index:2147483647';
  panel.innerHTML = `
    <div class="wsx-head">
      <div><div class="wsx-title">💬 Support Chat</div><div class="wsx-sub" id="wsxStatus">Connecting…</div></div>
      <button class="wsx-close" type="button">✕</button>
    </div>
    <div class="wsx-prechat" id="wsxPrechat">
      <div class="wsx-prechat-header"><div class="wsx-prechat-icon">👋</div><h3>Welcome!</h3><p>Please fill in your details to start chatting</p></div>
      <form id="wsxPrechatForm" class="wsx-prechat-form">
        <div class="wsx-form-group"><label for="wsxName">Your Name</label><input type="text" id="wsxName" placeholder="John Doe" required maxlength="50" /></div>
        <div class="wsx-form-group"><label for="wsxEmail">Email Address</label><input type="email" id="wsxEmail" placeholder="john@example.com" required maxlength="100" /></div>
        <div class="wsx-form-group"><label for="wsxDept">What do you need help with?</label><select id="wsxDept" required><option value="">Select a topic...</option></select></div>
        <button type="submit" class="wsx-start-btn">Start Chat</button>
      </form>
    </div>
    <div class="wsx-chat-area wsx-hidden" id="wsxChatArea">
      <div class="wsx-body" id="wsxBody"></div>
      <div class="wsx-toast" id="wsxToast"></div>
      <div class="wsx-typing" id="wsxTyping"><span class="wsx-typing-dot"></span><span class="wsx-typing-dot"></span><span class="wsx-typing-dot"></span></div>
      <form class="wsx-foot" id="wsxForm" autocomplete="off">
        <input class="wsx-in" id="wsxIn" placeholder="Type a message…" maxlength="2000" />
        <button class="wsx-send" type="submit"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg></button>
      </form>
      <button class="wsx-request-agent" id="wsxRequestAgent">👨‍💼 Talk to a Human</button>
    </div>`;
  document.body.appendChild(panel);

  const dot = qs('#wsxDot'), status = qs('#wsxStatus', panel), body = qs('#wsxBody', panel);
  const closeBtn = qs('.wsx-close', panel), form = qs('#wsxForm', panel), input = qs('#wsxIn', panel);
  const toast = qs('#wsxToast', panel), typing = qs('#wsxTyping', panel), prechat = qs('#wsxPrechat', panel);
  const chatArea = qs('#wsxChatArea', panel), prechatForm = qs('#wsxPrechatForm', panel);
  const nameInput = qs('#wsxName', panel), emailInput = qs('#wsxEmail', panel), deptSelect = qs('#wsxDept', panel);
  const requestAgentBtn = qs('#wsxRequestAgent', panel);

  let ws = null, myId = null, customerInfo = null, agentAvailable = false, config = {};

  function setDot(state) {
    const colors = { connected: ['#22c55e', 'rgba(34,197,94,.55)'], error: ['#ef4444', 'rgba(239,68,68,.55)'], connecting: ['#f59e0b', 'rgba(245,158,11,.55)'] };
    const [bg, shadow] = colors[state] || colors.connecting;
    dot.style.background = bg; dot.style.boxShadow = '0 0 10px ' + shadow;
  }

  function showToast(msg) { toast.textContent = msg; toast.classList.add('wsx-toast-on'); setTimeout(() => toast.classList.remove('wsx-toast-on'), 1800); }
  function scrollDown() { body.scrollTop = body.scrollHeight; }
  function showTyping() { typing.classList.add('wsx-typing-on'); setTimeout(() => typing.classList.remove('wsx-typing-on'), 2000); }

  function addChatMessage(msg) {
    const isMine = msg.from?.id === myId, isBot = msg.from?.isBot, isAgent = msg.from?.isAgent;
    const div = document.createElement('div');
    div.className = 'wsx-msg' + (isMine ? ' wsx-mine' : '') + (isBot ? ' wsx-bot' : '') + (isAgent ? ' wsx-agent' : '');
    let avatar = isBot ? '<span class="wsx-avatar">��</span>' : (isAgent ? '<span class="wsx-avatar">��‍💼</span>' : '');
    div.innerHTML = (!isMine ? avatar : '') + '<div class="wsx-msg-content"><div class="wsx-meta"><span class="wsx-name">' + esc(msg.from?.name || 'Unknown') + '</span><span>' + esc(nowTime(msg.ts)) + '</span></div><div class="wsx-bub">' + esc(msg.body || '') + '</div></div>';
    body.appendChild(div);
  }

  function populateDepartments(departments) {
    deptSelect.innerHTML = '<option value="">Select a topic...</option>';
    departments.forEach(dept => { const opt = document.createElement('option'); opt.value = dept; opt.textContent = dept; deptSelect.appendChild(opt); });
  }

  function showChatArea() { prechat.classList.add('wsx-hidden'); chatArea.classList.remove('wsx-hidden'); }

  function wsUrl() {
    const proto = baseOrigin.startsWith('https') ? 'wss:' : 'ws:';
    return proto + '//' + new URL(baseOrigin).host + '/?site=' + encodeURIComponent(site);
  }

  function connect() {
    setDot('connecting'); status.textContent = 'Connecting…';
    ws = new WebSocket(wsUrl());
    ws.onopen = () => { setDot('connected'); status.textContent = 'Online'; };
    ws.onmessage = (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; } if (!msg?.type) return;
      if (msg.type === 'welcome') {
        myId = msg.you?.id; agentAvailable = msg.agentAvailable; config = msg.config || {};
        if (config.departments) populateDepartments(config.departments);
        requestAgentBtn.style.display = agentAvailable ? 'block' : 'none';
        body.innerHTML = ''; msg.history?.forEach(addChatMessage); scrollDown();
      }
      if (msg.type === 'chat') {
        if (msg.from?.isBot) showTyping();
        setTimeout(() => { addChatMessage(msg); scrollDown(); }, msg.from?.isBot ? 500 : 0);
      }
      if (msg.type === 'info_received') showChatArea();
      if (msg.type === 'agent_status') {
        agentAvailable = msg.available; requestAgentBtn.style.display = agentAvailable ? 'block' : 'none';
        if (msg.available) showToast('An agent is now available!');
      }
    };
    ws.onclose = () => { setDot('connecting'); status.textContent = 'Reconnecting…'; setTimeout(connect, 2000); };
    ws.onerror = () => { setDot('error'); status.textContent = 'Connection error'; };
  }

  bubble.addEventListener('pointerdown', (e) => {
    e.preventDefault(); e.stopPropagation(); panel.classList.toggle('wsx-hidden');
    if (!panel.classList.contains('wsx-hidden')) (customerInfo ? input : nameInput).focus();
  });

  closeBtn.addEventListener('click', () => panel.classList.add('wsx-hidden'));

  prechatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    customerInfo = { name: nameInput.value.trim(), email: emailInput.value.trim(), department: deptSelect.value };
    if (!ws || ws.readyState !== WebSocket.OPEN) { showToast('Not connected'); return; }
    ws.send(JSON.stringify({ type: 'set_customer_info', ...customerInfo }));
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault(); const text = input.value.trim(); if (!text) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) { showToast('Not connected'); return; }
    ws.send(JSON.stringify({ type: 'chat', body: text })); input.value = '';
  });

  requestAgentBtn.addEventListener('click', () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) { showToast('Not connected'); return; }
    ws.send(JSON.stringify({ type: 'request_agent' })); requestAgentBtn.style.display = 'none'; showToast('Requesting agent...');
  });

  connect();
})();
