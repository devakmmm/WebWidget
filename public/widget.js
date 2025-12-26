(function(){
  'use strict';

  function qs(sel, root){ return (root || document).querySelector(sel); }
  function esc(s){ const d=document.createElement('div'); d.textContent=String(s||''); return d.innerHTML; }
  function nowTime(ts){ try { return new Date(ts).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});} catch { return ''; } }

  const script = document.currentScript;
  const site = (script && script.dataset && script.dataset.site) ? script.dataset.site.trim() : 'default';

  // inject css
  const cssHref = new URL('/widget.css', window.location.origin).toString();
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = cssHref;
  document.head.appendChild(link);

  // UI
  const bubble = document.createElement('div');
  bubble.className = 'wsx-bubble';
  bubble.innerHTML = '<div class="wsx-dot" id="wsxDot"></div><div style="font-weight:900">WS</div>';
  document.body.appendChild(bubble);

  const panel = document.createElement('div');
  panel.className = 'wsx-panel wsx-hidden';
  panel.innerHTML = `
    <div class="wsx-head">
      <div>
        <div class="wsx-title">Live Chat</div>
        <div class="wsx-sub" id="wsxStatus">Connecting…</div>
      </div>
      <button class="wsx-close" type="button" aria-label="Close">✕</button>
    </div>
    <div class="wsx-body" id="wsxBody" aria-live="polite"></div>
    <div class="wsx-toast" id="wsxToast"></div>
    <form class="wsx-foot" id="wsxForm" autocomplete="off">
      <input class="wsx-in" id="wsxIn" placeholder="Type a message…" maxlength="2000" />
      <button class="wsx-send" type="submit">Send</button>
    </form>
  `;
  document.body.appendChild(panel);

  const dot = qs('#wsxDot');
  const status = qs('#wsxStatus', panel);
  const body = qs('#wsxBody', panel);
  const closeBtn = qs('.wsx-close', panel);
  const form = qs('#wsxForm', panel);
  const input = qs('#wsxIn', panel);
  const toast = qs('#wsxToast', panel);

  function setDot(state){
    if (state === 'connected'){
      dot.style.background = '#22c55e';
      dot.style.boxShadow = '0 0 10px rgba(34,197,94,.55)';
    } else if (state === 'error'){
      dot.style.background = '#ef4444';
      dot.style.boxShadow = '0 0 10px rgba(239,68,68,.55)';
    } else {
      dot.style.background = '#f59e0b';
      dot.style.boxShadow = '0 0 10px rgba(245,158,11,.55)';
    }
  }

  function showToast(msg){
    toast.textContent = msg;
    toast.classList.add('wsx-toast-on');
    setTimeout(()=>toast.classList.remove('wsx-toast-on'), 1800);
  }

  let ws = null;
  let myId = null;

  function wsUrl(){
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}/?site=${encodeURIComponent(site)}`;
  }

  function connect(){
    setDot('connecting');
    status.textContent = 'Connecting…';

    ws = new WebSocket(wsUrl());

    ws.addEventListener('open', ()=>{
      setDot('connected');
      status.textContent = 'Connected';
    });

    ws.addEventListener('message', (e)=>{
      let msg = null;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (!msg || !msg.type) return;

      if (msg.type === 'welcome'){
        myId = msg.you && msg.you.id;
        if (Array.isArray(msg.history) && msg.history.length){
          body.innerHTML = '';
          msg.history.forEach(addChatMessage);
          scrollDown();
        }
        return;
      }

      if (msg.type === 'chat'){
        addChatMessage(msg);
        scrollDown();
      }
    });

    ws.addEventListener('close', ()=>{
      setDot('connecting');
      status.textContent = 'Disconnected — retrying…';
      setTimeout(connect, 2000);
    });

    ws.addEventListener('error', ()=>{
      setDot('error');
      status.textContent = 'Connection error';
    });
  }

  function scrollDown(){
    body.scrollTop = body.scrollHeight;
  }

  function addChatMessage(msg){
    const isMine = msg.from && msg.from.id === myId;
    const div = document.createElement('div');
    div.className = `wsx-msg ${isMine ? 'wsx-mine' : ''}`;
    div.innerHTML = `
      <div class="wsx-meta">
        <span class="wsx-name">${esc(msg.from ? msg.from.name : 'unknown')}</span>
        <span>${esc(nowTime(msg.ts))}</span>
      </div>
      <div class="wsx-bub">${esc(msg.body || '')}</div>
    `;
    body.appendChild(div);
  }

  bubble.addEventListener('click', ()=>{
    panel.classList.toggle('wsx-hidden');
    if (!panel.classList.contains('wsx-hidden')){
      input.focus();
    }
  });

  closeBtn.addEventListener('click', ()=> panel.classList.add('wsx-hidden'));

  form.addEventListener('submit', (e)=>{
    e.preventDefault();
    const text = (input.value || '').trim();
    if (!text) return;
    if (!ws || ws.readyState !== WebSocket.OPEN){
      showToast('Not connected');
      return;
    }
    ws.send(JSON.stringify({ type:'chat', body:text }));
    input.value = '';
  });

  connect();
})();