'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

// Resolve dependências a partir deste arquivo, independente do cwd
const mineflayer = require(path.join(__dirname, 'node_modules', 'mineflayer'));
const mc = require(path.join(__dirname, 'node_modules', 'minecraft-protocol'));

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'bots.json');
const PUBLIC_DIR = __dirname;
const DEFAULT_NICK = 'RochaBot';

// ── Persistência ─────────────────────────────────────────────────────────────

function loadBots() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveBots(bots) {
  const safe = bots.map(({ id, label, nick, host, port, version, autoConnect }) => ({
    id, label, nick, host, port, version: version || '', autoConnect: Boolean(autoConnect),
  }));
  // Escrita atômica: salva num temp e renomeia para evitar corrompimento
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(safe, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

// ── Estado em memória ─────────────────────────────────────────────────────────

let botConfigs = loadBots();
const runtime = {};

function getRuntime(id) {
  if (!runtime[id]) runtime[id] = { client: null, status: 'offline', log: [], chatLog: [] };
  return runtime[id];
}

function pushLog(id, msg) {
  const rt = getRuntime(id);
  rt.log.push({ t: Date.now(), msg: String(msg) });
  if (rt.log.length > 100) rt.log.shift();
}

function pushChat(id, direction, text) {
  const rt = getRuntime(id);
  rt.chatLog.push({ t: Date.now(), direction, text: String(text) });
  if (rt.chatLog.length > 150) rt.chatLog.shift();
}

// ── Auto-detect versão via ping ───────────────────────────────────────────────

function detectVersion(host, port) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 5000);
    try {
      mc.ping({ host, port: Number(port), closeTimeout: 4000 }, (err, result) => {
        clearTimeout(timer);
        if (err || !result) return resolve(null);
        // result.version.name ex: "1.21.4" ou "BungeeCord 1.21.x"
        const raw = String(result?.version?.name || result?.version || '');
        // Extrair somente "X.Y.Z" ou "X.Y"
        const match = raw.match(/\d+\.\d+(?:\.\d+)?/);
        resolve(match ? match[0] : null);
      });
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

// ── Conexão Minecraft ─────────────────────────────────────────────────────────

async function connectBot(id) {
  const cfg = botConfigs.find((b) => b.id === id);
  if (!cfg) return;

  const rt = getRuntime(id);
  if (rt.client && rt.status === 'online') return;

  // Desconectar instância anterior
  if (rt.client) {
    try { rt.client.quit(); } catch (_) {}
    rt.client = null;
  }

  rt.status = 'connecting';
  pushLog(id, `Conectando em ${cfg.host}:${cfg.port} como ${cfg.nick}...`);

  // Versão: usa a configurada, ou auto-detecta via ping
  let version = cfg.version || '';
  if (!version) {
    pushLog(id, 'Detectando versão do servidor...');
    const detected = await detectVersion(cfg.host, cfg.port);
    if (detected) {
      version = detected;
      pushLog(id, `Versão detectada: ${version}`);
    } else {
      pushLog(id, 'Não foi possível detectar versão, usando 1.21.4 como fallback.');
      version = '1.21.4';
    }
  }

  let bot;
  try {
    bot = mineflayer.createBot({
      host: cfg.host,
      port: Number(cfg.port),
      username: cfg.nick,
      version,
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
    pushLog(id, `Online no servidor. (v${version})`);
  });

  bot.on('chat', (username, message) => {
    if (username === bot.username) return;
    pushChat(id, 'in', `<${username}> ${message}`);
  });

  bot.on('message', (jsonMsg) => {
    const text = jsonMsg.toString().trim();
    if (text) pushChat(id, 'system', text);
  });

  bot.on('kicked', (reason) => {
    let msg = reason;
    try { msg = JSON.parse(reason)?.text || JSON.parse(reason)?.translate || reason; } catch (_) {}
    rt.status = 'offline';
    rt.client = null;
    pushLog(id, `Kickado: ${msg}`);
  });

  bot.on('error', (err) => {
    // Ignorar erros após desconexão intencional
    if (rt.status === 'offline') return;
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
    try { rt.client.quit('Desconectado pelo painel'); } catch (_) {}
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
    const nick = botConfigs.find((b) => b.id === id)?.nick || '?';
    pushChat(id, 'out', `<${nick}> ${message}`);
    return true;
  } catch (err) {
    pushLog(id, `Erro ao enviar: ${err.message}`);
    return false;
  }
}

// Auto-connect na inicialização
botConfigs.forEach((cfg) => { if (cfg.autoConnect) connectBot(cfg.id); });

// ── HTTP helpers ──────────────────────────────────────────────────────────────

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
    req.on('data', (c) => { body += c; if (body.length > 32768) reject(new Error('body too large')); });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

function newId() {
  return `bot_${Date.now()}_${Math.floor(Math.random() * 9000) + 1000}`;
}

// ── API ───────────────────────────────────────────────────────────────────────

async function handleApi(req, res, pathname) {
  // GET /api/bots
  if (req.method === 'GET' && pathname === '/api/bots') {
    return json(res, 200, {
      ok: true,
      bots: botConfigs.map((cfg) => {
        const rt = getRuntime(cfg.id);
        return { ...cfg, status: rt.status, log: rt.log.slice(-30), chatLog: rt.chatLog.slice(-50) };
      }),
    });
  }

  // POST /api/bots — criar
  if (req.method === 'POST' && pathname === '/api/bots') {
    const body = await readBody(req);
    const host = String(body.host || '').trim();
    if (!host) return json(res, 400, { ok: false, error: 'host obrigatorio' });
    const id = newId();
    const cfg = {
      id,
      label: String(body.label || host).trim(),
      nick: String(body.nick || DEFAULT_NICK).trim().slice(0, 16) || DEFAULT_NICK,
      host,
      port: Number(body.port) || 25565,
      version: String(body.version || '').trim(),
      autoConnect: Boolean(body.autoConnect),
    };
    botConfigs.push(cfg);
    saveBots(botConfigs);
    pushLog(id, 'Bot criado.');
    if (cfg.autoConnect) connectBot(id);
    return json(res, 200, { ok: true, id });
  }

  // Rotas /:id
  const m = pathname.match(/^\/api\/bots\/([^/]+)(\/.*)?$/);
  if (!m) return json(res, 404, { ok: false, error: 'rota nao encontrada' });

  const id = m[1];
  const sub = m[2] || '';
  const cfg = botConfigs.find((b) => b.id === id);
  if (!cfg) return json(res, 404, { ok: false, error: 'bot nao encontrado' });

  // PATCH — editar config
  if (req.method === 'PATCH' && sub === '') {
    const body = await readBody(req);
    if (body.label     !== undefined) cfg.label      = String(body.label).trim() || cfg.label;
    if (body.nick      !== undefined) cfg.nick       = String(body.nick).trim().slice(0, 16) || cfg.nick;
    if (body.host      !== undefined) cfg.host       = String(body.host).trim() || cfg.host;
    if (body.port      !== undefined) cfg.port       = Number(body.port) || cfg.port;
    if (body.version   !== undefined) cfg.version    = String(body.version).trim();
    if (body.autoConnect !== undefined) cfg.autoConnect = Boolean(body.autoConnect);
    saveBots(botConfigs);
    pushLog(id, 'Configuração atualizada.');
    return json(res, 200, { ok: true });
  }

  // DELETE — remover
  if (req.method === 'DELETE' && sub === '') {
    disconnectBot(id);
    botConfigs = botConfigs.filter((b) => b.id !== id);
    delete runtime[id];
    saveBots(botConfigs);
    return json(res, 200, { ok: true });
  }

  // POST /connect
  if (req.method === 'POST' && sub === '/connect') {
    connectBot(id); // async, não aguarda
    return json(res, 200, { ok: true });
  }

  // POST /disconnect
  if (req.method === 'POST' && sub === '/disconnect') {
    disconnectBot(id);
    return json(res, 200, { ok: true });
  }

  // POST /chat
  if (req.method === 'POST' && sub === '/chat') {
    const body = await readBody(req);
    const message = String(body.message || '').trim();
    if (!message) return json(res, 400, { ok: false, error: 'mensagem vazia' });
    const ok = sendChat(id, message);
    return json(res, ok ? 200 : 409, { ok, error: ok ? undefined : 'bot offline' });
  }

  return json(res, 404, { ok: false, error: 'rota nao encontrada' });
}

// ── Servidor ──────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return send(res, 204, {}, '');

  if (pathname.startsWith('/api/')) {
    try {
      await handleApi(req, res, pathname);
    } catch (err) {
      json(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  try {
    const data = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'));
    send(res, 200, { 'Content-Type': 'text/html; charset=utf-8' }, data);
  } catch {
    send(res, 404, { 'Content-Type': 'text/plain' }, 'not found');
  }
});

server.listen(PORT, () => {
  console.log(`Rocha Bot Manager rodando na porta ${PORT}`);
});
