'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const WebSocket = require('ws');
const nodemailer = require('nodemailer');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;

// Optional Postgres (recommended). If missing, fallback to in-memory.
const DATABASE_URL = process.env.DATABASE_URL || '';
const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: DATABASE_URL.includes('render.com') ? { rejectUnauthorized: false } : undefined
    })
  : null;

// Optional SMTP for notifications
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = Number(process.env.SMTP_PORT || 0);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const NOTIFY_EMAIL_TO = process.env.NOTIFY_EMAIL_TO || '';
const NOTIFY_EMAIL_FROM = process.env.NOTIFY_EMAIL_FROM || (SMTP_USER || '');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => res.status(200).send('ok'));
app.get('/demo', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'demo.html')));
app.get('/widget-test', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'widget-test.html')));
app.get('/widget.js', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'widget.js')));
app.get('/widget.css', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'widget.css')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

/**
 * Room state:
 * rooms: Map<site, { clients, nextId, botActive, botTimer, lastNotifiedAt }>
 */
const rooms = new Map();
const memoryHistory = new Map();

function nowISO() { return new Date().toISOString(); }
function safeJsonParse(s) { try { return JSON.parse(s); } catch { return null; } }

function getSiteFromReq(req) {
  try {
    const u = new URL(req.url, 'http://localhost');
    const raw = (u.searchParams.get('site') || 'default').trim();
    return raw.replace(/[^a-zA-Z0-9_\-]/g, '').slice(0, 48) || 'default';
  } catch {
    return 'default';
  }
}

function roomFor(site) {
  if (!rooms.has(site)) {
    rooms.set(site, { clients: new Map(), nextId: 1, botActive: false, botTimer: null, lastNotifiedAt: 0 });
  }
  return rooms.get(site);
}

function isRealClient(c) { return c && c.id > 0; }
function realClientCount(room) {
  let n = 0;
  for (const c of room.clients.values()) if (isRealClient(c)) n++;
  return n;
}

const BOT = { id: 0, name: 'BOT-NEON' };

function onlineList(room) {
  const list = Array.from(room.clients.values()).map(c => ({ id: c.id, name: c.name }));
  return room.botActive ? [{ id: BOT.id, name: BOT.name }, ...list] : list;
}

function broadcastRoom(room, obj) {
  const msg = JSON.stringify(obj);
  for (const ws of room.clients.keys()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

function broadcastRoomExcept(room, sender, obj) {
  const msg = JSON.stringify(obj);
  for (const ws of room.clients.keys()) {
    if (ws === sender) continue;
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

async function ensureSchema() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY,
      site TEXT NOT NULL,
      sender_id INT NOT NULL,
      sender_name TEXT NOT NULL,
      body TEXT NOT NULL,
      ts TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_site_ts ON messages(site, ts DESC);`);
}

async function saveMessage(site, from, body, tsISO) {
  if (pool) {
    await pool.query(
      `INSERT INTO messages(site, sender_id, sender_name, body, ts) VALUES ($1,$2,$3,$4,$5)`,
      [site, from.id, from.name, body, tsISO]
    );
  } else {
    const arr = memoryHistory.get(site) || [];
    arr.push({ from, body, ts: tsISO });
    while (arr.length > 100) arr.shift();
    memoryHistory.set(site, arr);
  }
}

async function loadHistory(site, limit = 25) {
  if (pool) {
    const r = await pool.query(
      `SELECT sender_id, sender_name, body, ts FROM messages WHERE site=$1 ORDER BY ts DESC LIMIT $2`,
      [site, limit]
    );
    return r.rows.reverse().map(x => ({
      type: 'chat',
      from: { id: x.sender_id, name: x.sender_name },
      body: x.body,
      ts: new Date(x.ts).toISOString()
    }));
  }
  const arr = memoryHistory.get(site) || [];
  return arr.slice(-limit).map(x => ({ type:'chat', from:x.from, body:x.body, ts:x.ts }));
}

function stopBot(room, site) {
  if (room.botTimer) {
    clearInterval(room.botTimer);
    room.botTimer = null;
  }
  if (room.botActive) {
    room.botActive = false;
    broadcastRoom(room, { type:'presence', action:'leave', user:{ id:BOT.id, name:BOT.name }, online: onlineList(room), ts: nowISO(), site });
  }
}

function botChat(room, site, body) {
  broadcastRoom(room, { type:'chat', from:{ id:BOT.id, name:BOT.name }, body, ts: nowISO(), site });
}

function startBotIfNeeded(room, site) {
  if (realClientCount(room) !== 1) return;
  if (room.botActive) return;

  room.botActive = true;
  broadcastRoom(room, { type:'presence', action:'join', user:{ id:BOT.id, name:BOT.name }, online: onlineList(room), ts: nowISO(), site });
  botChat(room, site, "You're the only one here. Type /help for commands.");

  room.botTimer = setInterval(() => {
    if (!room.botActive) return;
    if (realClientCount(room) !== 1) {
      stopBot(room, site);
      return;
    }
    const prompts = [
      "Want a human reply? Leave contact info and I’ll notify the owner.",
      "Type /help for commands.",
      "Describe what you need and I’ll suggest next steps.",
    ];
    botChat(room, site, prompts[Math.floor(Math.random() * prompts.length)]);
  }, 30000);
}

function botReply(room, site, text) {
  const t = String(text || '').trim();
  if (!t) return;

  if (t === '/help') return botChat(room, site, "Commands: /help, /ping, /about, /email you@example.com");
  if (t === '/ping') return botChat(room, site, "pong");
  if (t === '/about') return botChat(room, site, "I'm BOT-NEON. I activate when you're alone so the chat never feels dead.");

  if (t.startsWith('/email ')) {
    const email = t.slice(7).trim().slice(0, 120);
    botChat(room, site, `Captured: ${email}. (Enable SMTP env vars to email the owner automatically.)`);
    return;
  }

  if (t.endsWith('?')) return botChat(room, site, "Good question — share one more detail and I’ll be precise.");
  const clip = t.length > 140 ? `${t.slice(0,140)}…` : t;
  return botChat(room, site, `Noted: "${clip}". If you want a human reply, leave contact info or refresh later.`);
}

async function maybeNotifyOwner(site, body) {
  const room = roomFor(site);
  const now = Date.now();
  if (now - room.lastNotifiedAt < 120000) return;
  room.lastNotifiedAt = now;

  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS || !NOTIFY_EMAIL_TO || !NOTIFY_EMAIL_FROM) return;

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });

  await transporter.sendMail({
    from: NOTIFY_EMAIL_FROM,
    to: NOTIFY_EMAIL_TO,
    subject: `New chat message on site "${site}"`,
    text: `New visitor message on "${site}":\n\n${body}\n\nOpen your service URL to respond.`
  });
}

wss.on('connection', async (ws, req) => {
  const site = getSiteFromReq(req);
  const room = roomFor(site);

  const id = room.nextId++;
  const client = { id, name: `user-${id}` };
  room.clients.set(ws, client);

  const history = await loadHistory(site, 25);
  send(ws, { type:'welcome', you: client, online: onlineList(room), history, ts: nowISO(), site });

  broadcastRoomExcept(room, ws, { type:'presence', action:'join', user: client, online: onlineList(room), ts: nowISO(), site });

  stopBot(room, site);
  startBotIfNeeded(room, site);

  ws.on('message', async (raw) => {
    const msg = safeJsonParse(raw.toString());
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'set_name') {
      const desired = String(msg.name || '').trim();
      client.name = desired.slice(0, 24) || `user-${client.id}`;
      send(ws, { type:'name_set', you: client, online: onlineList(room), ts: nowISO(), site });
      broadcastRoom(room, { type:'presence', action:'rename', user: client, online: onlineList(room), ts: nowISO(), site });
      return;
    }

    if (msg.type === 'chat') {
      const body = String(msg.body || '').trim().slice(0, 2000);
      if (!body) return;

      const payload = { type:'chat', from:{ id: client.id, name: client.name }, body, ts: nowISO(), site };
      broadcastRoom(room, payload);
      await saveMessage(site, payload.from, payload.body, payload.ts);

      try { await maybeNotifyOwner(site, body); } catch {}

      if (room.botActive && realClientCount(room) === 1) {
        botReply(room, site, body);
      }
      return;
    }
  });

  ws.on('close', () => {
    room.clients.delete(ws);

    broadcastRoom(room, { type:'presence', action:'leave', user: client, online: onlineList(room), ts: nowISO(), site });

    stopBot(room, site);
    startBotIfNeeded(room, site);

    // Reset numbering when the room becomes empty
    if (room.clients.size === 0) {
      room.nextId = 1;
      room.lastNotifiedAt = 0;
    }
  });

  ws.on('error', () => {});
});

(async () => {
  try { await ensureSchema(); } catch (e) { console.error('DB schema init failed:', e.message); }
  server.listen(PORT, () => console.log(`WebSocket Widget SaaS listening on port ${PORT}`));
})();
