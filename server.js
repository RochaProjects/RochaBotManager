'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const mineflayer = require('mineflayer');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'bots.json');
const PUBLIC_DIR = __dirname;

// Nick padrão global — todos os bots novos herdam se não tiver nick próprio
const DEFAULT_NICK = 'RochaBot';

// ── Persistência ────────────────────────────────────────────────────────────

function loadBots() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function saveBots(bots) {
  const safe = bots.map(({ id, label, nick, host, port, version, autoConnect }) => ({
    id, label, nick, host, port, version, autoConnect: Boolean(autoConnect),
  }));
  fs.writeFileSync(DATA_FILE, JSON.stringify(safe, null, 2));
}

// ── Estado em memória ────────────────────────────────────────────────────────

// configs persistidas
let botConfigs = loadBots();

// runtime por id: { client, status, log, chatLog }
const runtime = {};

function getRuntime(id) {
  if (!runtime[id]) {
    runtime[id] = { client: null, status: 'offline', log: [], chatLog: [] };
  }
  return runtime[id];
}

function pushLog(id, msg) {
  const rt = getRuntime(id);
  rt.log.push({ t: Date.now(), msg });
  if (rt.log.length > 80) rt.log.shift();
}

function pushChat(id, direction, text) {
  const rt = getRuntime(id);
  rt.chatLog.push({ t: Date.now(), direction, text });
  if (rt.chatLog.length > 100) rt.chatLog.shift();
}

// ── Conexão Minecraft ────────────────────────────────────────────────────────

function connectBot(id) {
  const cfg = botConfigs.find((b) => b.id === id);
  if (!cfg) return;

  const rt = getRuntime(id);

  // Já conectado
  if (rt.client && rt.status === 'online') return;

  // Desconectar instância anterior se existir
  if (rt.client) {
    try { rt.client.quit(); } catch (_) { }
    rt.client = null;
  }

  rt.status = 'connecting';
  pushLog(id, `Conectando em ${cfg.host}:${cfg.port} como ${cfg.nick}...`);

  let bot;
  try {
    bot = mineflayer.createBot({
      host: cfg.host,
      port: Number(cfg.port),
      username: cfg.nick,
      version: cfg.version || false,
      auth: 'offline',
      keepAlive: true,
      checkTimeoutInterval: 30000,
    });
  } catch (err) {
    rt.status = 'error';
    pushLog(id, `Erro ao criar bot: ${err.message}`);
    return;
  }

  rt.client = bot;

  bot.on('login', () => {
    rt.status = 'online';
    pushLog(id, 'Conectado ao servidor.');
  });

  bot.on('chat', (username, message) => {
    if (username === bot.username) return;
    pushChat(id, 'in', `<${username}> ${message}`);
  });

  bot.on('message', (jsonMsg) => {
    const text = jsonMsg.toString();
    if (text && !text.includes(bot.username)) {
      pushChat(id, 'system', text);
    }
  });

  bot.on('kicked', (reason) => {
    let msg = reason;
    try { msg = JSON.parse(reason)?.text || reason; } catch (_) { }
    rt.status = 'offline';
    rt.client = null;
    pushLog(id, `Kickado: ${msg}`);
  });

  bot.on('error', (err) => {
    rt.status = 'error';
    rt.client = null;
    pushLog(id, `Erro: ${err.message}`);
  });

  bot.on('end', (reason) => {
    if (rt.status !== 'offline') {
      rt.status = 'offline';
      rt.client = null;
      pushLog(id, `Desconectado: ${reason || 'conexão encerrada'}`);
    }
  });
}

function disconnectBot(id) {
  const rt = getRuntime(id);
  if (rt.client) {
    try { rt.client.quit('Desconectado pelo painel'); } catch (_) { }
    rt.client = null;
  }
  rt.status = 'offline';
  pushLog(id, 'Desconectado pelo painel.');
}

function sendChat(id, message) {
  const rt = getRuntime(id);
  if (!rt.client || rt.status !== 'online') return false;
  try {
    rt.client.chat(message);
    pushChat(id, 'out', `<${botConfigs.find((b) => b.id === id)?.nick}> ${message}`);
    return true;
  } catch (err) {
    pushLog(id, `Erro ao enviar mensagem: ${err.message}`);
    return false;
  }
}

// Auto-connect na inicialização
botConfigs.forEach((cfg) => {
  if (cfg.autoConnect) connectBot(cfg.id);
});

// ── Helpers HTTP ─────────────────────────────────────────────────────────────

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

function json(res, status, data) {
  send(res, status, { 'Content-Type': 'application/json; charset=utf-8' }, JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 16384) reject(new Error('body too large')); });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

function newId() {
  return `bot_${Date.now()}_${Math.floor(Math.random() * 9000) + 1000}`;
}

// ── Rotas API ─────────────────────────────────────────────────────────────────

async function handleApi(req, res, pathname) {
  const url = new URL(req.url, `http://localhost`);

  // GET /api/bots — lista todos com status
  if (req.method === 'GET' && pathname === '/api/bots') {
    const list = botConfigs.map((cfg) => {
      const rt = getRuntime(cfg.id);
      return {
        id: cfg.id,
        label: cfg.label,
        nick: cfg.nick,
        host: cfg.host,
        port: cfg.port,
        version: cfg.version,
        autoConnect: cfg.autoConnect,
        status: rt.status,
        log: rt.log.slice(-20),
        chatLog: rt.chatLog.slice(-30),
      };
    });
    return json(res, 200, { ok: true, bots: list });
  }

  // POST /api/bots — criar bot
  if (req.method === 'POST' && pathname === '/api/bots') {
    const body = await readBody(req);
    const host = String(body.host || '').trim();
    const port = Number(body.port) || 25565;
    const nick = String(body.nick || DEFAULT_NICK).trim().slice(0, 16) || DEFAULT_NICK;
    const label = String(body.label || host).trim() || host;
    const version = String(body.version || '').trim() || false;
    const autoConnect = Boolean(body.autoConnect);

    if (!host) return json(res, 400, { ok: false, error: 'host obrigatorio' });

    const id = newId();
    const cfg = { id, label, nick, host, port, version, autoConnect };
    botConfigs.push(cfg);
    saveBots(botConfigs);
    getRuntime(id).status = 'offline';
    pushLog(id, 'Bot criado.');

    if (autoConnect) connectBot(id);

    return json(res, 200, { ok: true, id });
  }

  // Rotas com /:id
  const matchId = pathname.match(/^\/api\/bots\/([^/]+)(\/.*)?$/);
  if (!matchId) return json(res, 404, { ok: false, error: 'rota nao encontrada' });

  const id = matchId[1];
  const sub = matchId[2] || '';
  const cfg = botConfigs.find((b) => b.id === id);
  if (!cfg) return json(res, 404, { ok: false, error: 'bot nao encontrado' });

  // PATCH /api/bots/:id — editar nick/label/host/port/version/autoConnect
  if (req.method === 'PATCH' && sub === '') {
    const body = await readBody(req);
    if (body.nick !== undefined) cfg.nick = String(body.nick).trim().slice(0, 16) || cfg.nick;
    if (body.label !== undefined) cfg.label = String(body.label).trim() || cfg.label;
    if (body.host !== undefined) cfg.host = String(body.host).trim() || cfg.host;
    if (body.port !== undefined) cfg.port = Number(body.port) || cfg.port;
    if (body.version !== undefined) cfg.version = String(body.version).trim() || false;
    if (body.autoConnect !== undefined) cfg.autoConnect = Boolean(body.autoConnect);
    saveBots(botConfigs);
    pushLog(id, 'Configuração atualizada.');
    return json(res, 200, { ok: true });
  }

  // DELETE /api/bots/:id — remover bot
  if (req.method === 'DELETE' && sub === '') {
    disconnectBot(id);
    botConfigs = botConfigs.filter((b) => b.id !== id);
    delete runtime[id];
    saveBots(botConfigs);
    return json(res, 200, { ok: true });
  }

  // POST /api/bots/:id/connect
  if (req.method === 'POST' && sub === '/connect') {
    connectBot(id);
    return json(res, 200, { ok: true, status: getRuntime(id).status });
  }

  // POST /api/bots/:id/disconnect
  if (req.method === 'POST' && sub === '/disconnect') {
    disconnectBot(id);
    return json(res, 200, { ok: true });
  }

  // POST /api/bots/:id/chat
  if (req.method === 'POST' && sub === '/chat') {
    const body = await readBody(req);
    const message = String(body.message || '').trim();
    if (!message) return json(res, 400, { ok: false, error: 'mensagem vazia' });
    const ok = sendChat(id, message);
    return json(res, ok ? 200 : 409, { ok, error: ok ? undefined : 'bot offline' });
  }

  // GET /api/bots/:id/log
  if (req.method === 'GET' && sub === '/log') {
    const rt = getRuntime(id);
    return json(res, 200, { ok: true, log: rt.log, chatLog: rt.chatLog });
  }

  return json(res, 404, { ok: false, error: 'rota nao encontrada' });
}

// ── Servidor ──────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);
  const pathname = url.pathname;

  // CORS simples para dev
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return send(res, 204, {}, '');

  // API
  if (pathname.startsWith('/api/')) {
    try {
      await handleApi(req, res, pathname);
    } catch (err) {
      json(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // Servir index.html para qualquer outra rota
  const file = path.join(PUBLIC_DIR, 'index.html');
  try {
    const data = fs.readFileSync(file);
    send(res, 200, { 'Content-Type': 'text/html; charset=utf-8' }, data);
  } catch {
    send(res, 404, { 'Content-Type': 'text/plain' }, 'not found');
  }
});

server.listen(PORT, () => {
  console.log(`Rocha Bot Manager rodando na porta ${PORT}`);
});
