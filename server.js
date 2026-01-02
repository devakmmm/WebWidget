'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const WebSocket = require('ws');
const nodemailer = require('nodemailer');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;

const DATABASE_URL = process.env.DATABASE_URL || '';
const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: DATABASE_URL.includes('render.com') ? { rejectUnauthorized: false } : undefined
    })
  : null;

const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = Number(process.env.SMTP_PORT || 0);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const NOTIFY_EMAIL_TO = process.env.NOTIFY_EMAIL_TO || '';
const NOTIFY_EMAIL_FROM = process.env.NOTIFY_EMAIL_FROM || (SMTP_USER || '');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => res.status(200).send('ok'));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'demo.html')));
app.get('/demo', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'demo.html')));
app.get('/widget-test', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'widget-test.html')));
app.get('/agent', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'agent-dashboard.html')));
app.get('/widget.js', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'widget.js')));
app.get('/widget.css', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'widget.css')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const DEFAULT_FAQ = {
  order: {
    keywords: ['order', 'delivery', 'track', 'shipping', 'package', 'arrived', 'late', 'where'],
    responses: [
      "I can help with your order! Could you please share your order number or email address?",
      "For order tracking, check your confirmation email for the tracking number.",
      "Most orders arrive within 3-5 business days. Would you like me to look up a specific order?"
    ],
    autoResolve: [
      { trigger: 'track', response: "To track your order, please check the confirmation email or provide your order number." },
      { trigger: 'cancel', response: "I understand you want to cancel. I'm connecting you with an agent who can help. Please hold." }
    ]
  },
  billing: {
    keywords: ['bill', 'charge', 'refund', 'payment', 'invoice', 'receipt', 'price', 'cost', 'money'],
    responses: [
      "I'll help with your billing question. Can you describe the issue?",
      "For refund requests, I'll connect you with our billing team."
    ],
    autoResolve: [
      { trigger: 'receipt', response: "Receipts are sent to your email after purchase. Check your spam folder, or I can resend it." },
      { trigger: 'refund', response: "I'll connect you with our billing specialist for refund requests. One moment please." }
    ]
  },
  technical: {
    keywords: ['error', 'bug', 'crash', 'not working', 'broken', 'issue', 'problem', 'help', 'how to', 'cant', "can't", 'unable'],
    responses: [
      "I'm sorry you're having technical difficulties. Can you describe what's happening?",
      "Have you tried refreshing the page or clearing your browser cache?"
    ],
    autoResolve: [
      { trigger: 'login', response: "For login issues: 1) Reset your password, 2) Clear cookies, 3) Try incognito mode. Still stuck? I'll connect you with support." },
      { trigger: 'password', response: "To reset your password, click 'Forgot Password' on the login page. You'll get a reset link within 5 minutes." }
    ]
  },
  general: {
    keywords: [],
    responses: ["Thanks for reaching out! How can I help you today?"],
    autoResolve: []
  }
};

const businessConfigs = new Map();

function getBusinessConfig(site) {
  if (!businessConfigs.has(site)) {
    businessConfigs.set(site, {
      name: site,
      faq: { ...DEFAULT_FAQ },
      welcomeMessage: "Hi there! I'm your virtual assistant. How can I help you today?",
      offlineMessage: "We're currently offline, but leave your message and we'll respond within 24 hours.",
      departments: ['General Support', 'Sales', 'Billing', 'Technical'],
      businessHours: { start: 9, end: 17, timezone: 'UTC' }
    });
  }
  return businessConfigs.get(site);
}

const rooms = new Map();
const memoryHistory = new Map();

function nowISO() { return new Date().toISOString(); }
function safeJsonParse(s) { try { return JSON.parse(s); } catch { return null; } }

function getSiteFromReq(req) {
  try {
    const u = new URL(req.url, 'http://localhost');
    const raw = (u.searchParams.get('site') || 'default').trim();
    return raw.replace(/[^a-zA-Z0-9_\-]/g, '').slice(0, 48) || 'default';
  } catch { return 'default'; }
}

function isAgentFromReq(req) {
  try {
    const u = new URL(req.url, 'http://localhost');
    return u.searchParams.get('role') === 'agent';
  } catch { return false; }
}

function roomFor(site) {
  if (!rooms.has(site)) {
    rooms.set(site, {
      clients: new Map(),
      agents: new Map(),
      nextId: 1,
      conversations: new Map(),
      lastNotifiedAt: 0
    });
  }
  return rooms.get(site);
}

const BOT = { id: 0, name: 'Support Bot', isBot: true };

function hasAvailableAgent(room) { return room.agents.size > 0; }

function broadcastRoom(room, obj) {
  const msg = JSON.stringify(obj);
  for (const ws of room.clients.keys()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

function broadcastAgents(room, obj) {
  const msg = JSON.stringify(obj);
  for (const ws of room.agents.keys()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

function broadcastToConversation(room, visitorId, obj, includeAgents = true) {
  const msg = JSON.stringify(obj);
  for (const [ws, client] of room.clients.entries()) {
    if (client.id === visitorId && ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
  if (includeAgents) {
    for (const ws of room.agents.keys()) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }
}

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function detectCategory(text, faq) {
  const lower = text.toLowerCase();
  for (const [category, config] of Object.entries(faq)) {
    if (category === 'general') continue;
    for (const keyword of config.keywords) {
      if (lower.includes(keyword)) return category;
    }
  }
  return 'general';
}

function getAutoResponse(text, category, faq) {
  const lower = text.toLowerCase();
  const config = faq[category];
  if (config && config.autoResolve) {
    for (const rule of config.autoResolve) {
      if (lower.includes(rule.trigger)) {
        return { response: rule.response, shouldEscalate: rule.response.includes('connect') };
      }
    }
  }
  if (config && config.responses && config.responses.length > 0) {
    return { response: config.responses[Math.floor(Math.random() * config.responses.length)], shouldEscalate: false };
  }
  return { response: null, shouldEscalate: false };
}

function botChat(room, site, visitorId, body) {
  const payload = { type: 'chat', from: BOT, body, ts: nowISO(), site, visitorId };
  broadcastToConversation(room, visitorId, payload);
}

function handleBotMessage(room, site, visitorId, text, conversation) {
  const config = getBusinessConfig(site);
  const category = detectCategory(text, config.faq);
  
  if (category !== 'general' && conversation.category === 'general') {
    conversation.category = category;
    broadcastAgents(room, { type: 'conversation_update', visitorId, conversation: { ...conversation }, ts: nowISO(), site });
  }
  
  const { response, shouldEscalate } = getAutoResponse(text, category, config.faq);
  
  if (response) {
    setTimeout(() => {
      botChat(room, site, visitorId, response);
      if (shouldEscalate && hasAvailableAgent(room)) {
        conversation.status = 'waiting';
        setTimeout(() => {
          botChat(room, site, visitorId, "I've notified our support team. An agent will be with you shortly.");
          broadcastAgents(room, { type: 'escalation', visitorId, conversation: { ...conversation }, ts: nowISO(), site });
        }, 1000);
      }
    }, 800);
  } else if (!hasAvailableAgent(room)) {
    setTimeout(() => botChat(room, site, visitorId, config.offlineMessage), 800);
  }
}

async function ensureSchema() {
  if (!pool) return;
  await pool.query('CREATE TABLE IF NOT EXISTS messages (id BIGSERIAL PRIMARY KEY, site TEXT NOT NULL, sender_id INT NOT NULL, sender_name TEXT NOT NULL, body TEXT NOT NULL, visitor_id INT, ts TIMESTAMPTZ NOT NULL DEFAULT NOW())');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_messages_site_ts ON messages(site, ts DESC)');
}

async function saveMessage(site, from, body, tsISO, visitorId) {
  if (pool) {
    await pool.query('INSERT INTO messages(site, sender_id, sender_name, body, visitor_id, ts) VALUES ($1,$2,$3,$4,$5,$6)', [site, from.id, from.name, body, visitorId, tsISO]);
  } else {
    const arr = memoryHistory.get(site) || [];
    arr.push({ from, body, ts: tsISO, visitorId });
    while (arr.length > 500) arr.shift();
    memoryHistory.set(site, arr);
  }
}

async function loadHistory(site, visitorId, limit = 25) {
  if (pool) {
    const r = await pool.query('SELECT sender_id, sender_name, body, ts, visitor_id FROM messages WHERE site=$1 AND visitor_id=$2 ORDER BY ts DESC LIMIT $3', [site, visitorId, limit]);
    return r.rows.reverse().map(x => ({ type: 'chat', from: { id: x.sender_id, name: x.sender_name }, body: x.body, ts: new Date(x.ts).toISOString(), visitorId: x.visitor_id }));
  }
  const arr = memoryHistory.get(site) || [];
  return arr.filter(x => x.visitorId === visitorId).slice(-limit).map(x => ({ type: 'chat', from: x.from, body: x.body, ts: x.ts, visitorId: x.visitorId }));
}

async function maybeNotifyOwner(site, body, customerInfo) {
  const room = roomFor(site);
  const now = Date.now();
  if (now - room.lastNotifiedAt < 120000) return;
  room.lastNotifiedAt = now;
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS || !NOTIFY_EMAIL_TO) return;
  const transporter = nodemailer.createTransport({ host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465, auth: { user: SMTP_USER, pass: SMTP_PASS } });
  const customerDetails = customerInfo ? '\nCustomer: ' + (customerInfo.name || 'Unknown') + '\nEmail: ' + (customerInfo.email || 'N/A') : '';
  await transporter.sendMail({ from: NOTIFY_EMAIL_FROM, to: NOTIFY_EMAIL_TO, subject: 'New support chat on "' + site + '"', text: 'New message on "' + site + '":' + customerDetails + '\n\nMessage: ' + body });
}

wss.on('connection', async (ws, req) => {
  const site = getSiteFromReq(req);
  const isAgent = isAgentFromReq(req);
  const room = roomFor(site);
  const config = getBusinessConfig(site);
  const id = room.nextId++;
  
  if (isAgent) {
    const agent = { id, name: 'Agent-' + id, isAgent: true };
    room.agents.set(ws, agent);
    
    const conversations = {};
    for (const [visitorId, conv] of room.conversations.entries()) {
      conversations[visitorId] = { ...conv, history: await loadHistory(site, visitorId, 50) };
    }
    
    send(ws, { type: 'agent_welcome', you: agent, conversations, config, ts: nowISO(), site });
    broadcastRoom(room, { type: 'agent_status', available: true, ts: nowISO(), site });
    
    ws.on('message', async (raw) => {
      const msg = safeJsonParse(raw.toString());
      if (!msg) return;
      
      if (msg.type === 'set_name') {
        agent.name = String(msg.name || '').trim().slice(0, 24) || ('Agent-' + id);
        send(ws, { type: 'name_set', you: agent, ts: nowISO(), site });
      }
      
      if (msg.type === 'agent_chat') {
        const body = String(msg.body || '').trim().slice(0, 2000);
        const visitorId = msg.visitorId;
        if (!body || !visitorId) return;
        
        const conversation = room.conversations.get(visitorId);
        if (conversation) { conversation.status = 'active'; conversation.assignedAgent = agent.id; }
        
        const payload = { type: 'chat', from: { id: agent.id, name: agent.name, isAgent: true }, body, ts: nowISO(), site, visitorId };
        broadcastToConversation(room, visitorId, payload);
        await saveMessage(site, payload.from, payload.body, payload.ts, visitorId);
      }
      
      if (msg.type === 'resolve_conversation') {
        const conversation = room.conversations.get(msg.visitorId);
        if (conversation) {
          conversation.status = 'resolved';
          botChat(room, site, msg.visitorId, "This conversation has been resolved. Thank you for contacting us!");
          broadcastAgents(room, { type: 'conversation_update', visitorId: msg.visitorId, conversation: { ...conversation }, ts: nowISO(), site });
        }
      }
    });
    
    ws.on('close', () => {
      room.agents.delete(ws);
      if (room.agents.size === 0) broadcastRoom(room, { type: 'agent_status', available: false, ts: nowISO(), site });
    });
    
  } else {
    const client = { id, name: 'Visitor-' + id };
    room.clients.set(ws, client);
    room.conversations.set(id, { status: 'bot', category: 'general', assignedAgent: null, customerInfo: null, startedAt: nowISO() });
    
    const history = await loadHistory(site, id, 25);
    send(ws, { type: 'welcome', you: client, agentAvailable: hasAvailableAgent(room), config: { welcomeMessage: config.welcomeMessage, departments: config.departments, businessName: config.name }, history, ts: nowISO(), site });
    
    broadcastAgents(room, { type: 'new_visitor', visitor: client, conversation: room.conversations.get(id), ts: nowISO(), site });
    setTimeout(() => botChat(room, site, id, config.welcomeMessage), 500);
    
    ws.on('message', async (raw) => {
      const msg = safeJsonParse(raw.toString());
      if (!msg) return;
      
      if (msg.type === 'set_customer_info') {
        const conversation = room.conversations.get(id);
        if (conversation) {
          conversation.customerInfo = { name: String(msg.name || '').trim().slice(0, 50), email: String(msg.email || '').trim().slice(0, 100), department: String(msg.department || '').trim().slice(0, 50) };
          client.name = conversation.customerInfo.name || ('Visitor-' + id);
          broadcastAgents(room, { type: 'conversation_update', visitorId: id, conversation: { ...conversation }, ts: nowISO(), site });
          send(ws, { type: 'info_received', ts: nowISO(), site });
          setTimeout(() => botChat(room, site, id, 'Thanks ' + conversation.customerInfo.name + '! How can I help you with ' + (conversation.customerInfo.department || 'your inquiry') + '?'), 500);
        }
      }
      
      if (msg.type === 'chat') {
        const body = String(msg.body || '').trim().slice(0, 2000);
        if (!body) return;
        const conversation = room.conversations.get(id);
        const payload = { type: 'chat', from: { id: client.id, name: client.name }, body, ts: nowISO(), site, visitorId: id };
        broadcastToConversation(room, id, payload);
        await saveMessage(site, payload.from, payload.body, payload.ts, id);
        try { await maybeNotifyOwner(site, body, conversation?.customerInfo); } catch {}
        if (conversation && (conversation.status === 'bot' || conversation.status === 'waiting')) {
          handleBotMessage(room, site, id, body, conversation);
        }
      }
      
      if (msg.type === 'request_agent') {
        const conversation = room.conversations.get(id);
        if (conversation) {
          conversation.status = 'waiting';
          broadcastAgents(room, { type: 'escalation', visitorId: id, conversation: { ...conversation }, ts: nowISO(), site });
          botChat(room, site, id, hasAvailableAgent(room) ? "I'm connecting you with a support agent. Please hold..." : "No agents available. Leave your message and we'll respond soon.");
        }
      }
    });
    
    ws.on('close', () => {
      room.clients.delete(ws);
      broadcastAgents(room, { type: 'visitor_left', visitorId: id, ts: nowISO(), site });
      const conversation = room.conversations.get(id);
      if (conversation && conversation.status !== 'resolved') conversation.status = 'ended';
    });
  }
  
  ws.on('error', () => {});
});

// Self-ping to prevent Render idle timeout (every 14 minutes)
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || '';
function keepAlive() {
  if (!RENDER_URL) return;
  const https = require('https');
  const http = require('http');
  const url = RENDER_URL + '/health';
  const client = url.startsWith('https') ? https : http;
  client.get(url, (res) => {
    console.log('[Keep-Alive] Ping status:', res.statusCode);
  }).on('error', (err) => {
    console.error('[Keep-Alive] Ping failed:', err.message);
  });
}

(async () => {
  try { await ensureSchema(); } catch (e) { console.error('DB schema init failed:', e.message); }
  server.listen(PORT, () => {
    console.log('');
    console.log('='.repeat(60));
    console.log('  Support Chat Widget - Ready for Business!');
    console.log('='.repeat(60));
    console.log('  Server running on port ' + PORT);
    console.log('');
    console.log('  Widget Demo:     http://localhost:' + PORT + '/demo');
    console.log('  Agent Dashboard: http://localhost:' + PORT + '/agent');
    console.log('  Widget Test:     http://localhost:' + PORT + '/widget-test');
    console.log('');
    console.log('  Embed on any site:');
    console.log('  <script src="http://localhost:' + PORT + '/widget.js"');
    console.log('          data-site="your-business"></script>');
    console.log('='.repeat(60));
    
    // Start keep-alive pings every 14 minutes (Render idles after 15 min)
    if (RENDER_URL) {
      console.log('  Keep-alive enabled for:', RENDER_URL);
      setInterval(keepAlive, 14 * 60 * 1000);
      keepAlive(); // Initial ping
    }
  });
})();
