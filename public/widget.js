(function () {
  'use strict';

  /***********************
   * Helpers (FIXES ERROR)
   ***********************/
  function qs(sel, root = document) {
    return root.querySelector(sel);
  }

  function esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, (m) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[m]));
  }

  function nowTime(ts) {
    const d = ts ? new Date(ts) : new Date();
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  /***********************
   * Config
   ***********************/
  const script = document.currentScript;
  const site =
    script?.dataset?.site?.trim() || 'default';

  const baseOrigin = script?.src
    ? new URL(script.src).origin
    : window.location.origin;

  /***********************
   * Inject CSS
   ***********************/
  const cssHref = new URL('/widget.css', baseOrigin).toString();
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = cssHref;
  document.head.appendChild(link);

  /***********************
   * UI
   ***********************/
  const bubble = document.createElement('div');
  bubble.className = 'wsx-bubble';
  bubble.innerHTML = `
    <div class="wsx-dot" id="wsxDot"></div>
    <div style="font-weight:900">WS</div>
  `;
  bubble.style.pointerEvents = 'auto';
  bubble.style.zIndex = '2147483647';
  document.body.appendChild(bubble);

  const panel = document.createElement('div');
  panel.className = 'wsx-panel wsx-hidden';
  panel.style.pointerEvents = 'auto';
  panel.style.zIndex = '2147483647';
  panel.innerHTML = `
    <div class="wsx-head">
      <div>
        <div class="wsx-title">Live Chat</div>
        <div class="wsx-sub" id="wsxStatus">Connecting…</div>
      </div>
      <button class="wsx-close" type="button">✕</button>
    </div>
    <div class="wsx-body" id="wsxBody"></div>
    <div class="wsx-toast" id="wsxToast"></div>
    <form class="wsx-foot" id="wsxForm" autocomplete="off">
      <input class="wsx-in" id="wsxIn" placeholder="Type a message…" maxlength="2000" />
      <button class="wsx-send" type="submit">Send</button>
    </form>
  `;
  document.body.appendChild(panel);

  /***********************
   * Elements
   ***********************/
  const dot = qs('#wsxDot');
  const status = qs('#wsxStatus', panel);
  const body = qs('#wsxBody', panel);
  const closeBtn = qs('.wsx-close', panel);
  const form = qs('#wsxForm', panel);
  const input = qs('#wsxIn', panel);
  const toast = qs('#wsxToast', panel);

  /***********************
   * State
   ***********************/
  let ws = null;
  let myId = null;

  /***********************
   * UI helpers
   ***********************/
  function setDot(state) {
    if (state === 'connected') {
      dot.style.background = '#22c55e';
      dot.style.boxShadow = '0 0 10px rgba(34,197,94,.55)';
    } else if (state === 'error') {
      dot.style.background = '#ef4444';
      dot.style.boxShadow = '0 0 10px rgba(239,68,68,.55)';
    } else {
      dot.style.background = '#f59e0b';
      dot.style.boxShadow = '0 0 10px rgba(245,158,11,.55)';
    }
  }

  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('wsx-toast-on');
    setTimeout(() => toast.classList.remove('wsx-toast-on'), 1800);
  }

  function scrollDown() {
    body.scrollTop = body.scrollHeight;
  }

  function addChatMessage(msg) {
    const isMine = msg.from?.id === myId;
    const div = document.createElement('div');
    div.className = `wsx-msg ${isMine ? 'wsx-mine' : ''}`;
    div.innerHTML = `
      <div class="wsx-meta">
        <span class="wsx-name">${esc(msg.from?.name || 'anon')}</span>
        <span>${esc(nowTime(msg.ts))}</span>
      </div>
      <div class="wsx-bub">${esc(msg.body || '')}</div>
    `;
    body.appendChild(div);
  }

  /***********************
   * WebSocket
   ***********************/
  function wsUrl() {
    const proto = baseOrigin.startsWith('https') ? 'wss:' : 'ws:';
    const host = new URL(baseOrigin).host;
    return `${proto}//${host}/?site=${encodeURIComponent(site)}`;
  }

  function connect() {
    setDot('connecting');
    status.textContent = 'Connecting…';

    ws = new WebSocket(wsUrl());

    ws.onopen = () => {
      setDot('connected');
      status.textContent = 'Connected';
    };

    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (!msg?.type) return;

      if (msg.type === 'welcome') {
        myId = msg.you?.id;
        body.innerHTML = '';
        msg.history?.forEach(addChatMessage);
        scrollDown();
      }

      if (msg.type === 'chat') {
        addChatMessage(msg);
        scrollDown();
      }
    };

    ws.onclose = () => {
      setDot('connecting');
      status.textContent = 'Disconnected — retrying…';
      setTimeout(connect, 2000);
    };

    ws.onerror = () => {
      setDot('error');
      status.textContent = 'Connection error';
    };
  }

  /***********************
   * Events (CLICK FIX)
   ***********************/
  bubble.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    panel.classList.toggle('wsx-hidden');
    if (!panel.classList.contains('wsx-hidden')) input.focus();
  });

  closeBtn.addEventListener('click', () => {
    panel.classList.add('wsx-hidden');
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;

    if (!ws || ws.readyState !== WebSocket.OPEN) {
      showToast('Not connected');
      return;
    }

    ws.send(JSON.stringify({ type: 'chat', body: text }));
    input.value = '';
  });

  /***********************
   * Start
   ***********************/
  connect();
})();
