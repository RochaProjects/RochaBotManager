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

  // Avisa se outro bot online já usa o mesmo nick no mesmo servidor
  const conflict = botConfigs.find((b) =>
    b.id !== id && b.host === cfg.host && b.port === cfg.port &&
    b.nick === cfg.nick && getRuntime(b.id).status === 'online'
  );
  if (conflict) {
    pushLog(id, `AVISO: bot "${conflict.label || conflict.id}" já está online com o nick "${cfg.nick}" no mesmo servidor. O servidor pode kickar um dos dois.`);
  }

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

  // Patcha o minecraft-data para definir packet_common_transfer antes de criar o bot.
  // O transfer packet (Velocity/MC 1.20.5+) já aparece no mapeamento de IDs do
  // minecraft-data, mas sem definição de tipo — isso faz o protocolo lançar
  // "A packet did not decode successfully" ao receber o pacote.
  // Estrutura: host (string) + port (varint)
  try {
    const mcData = require(path.join(__dirname, 'node_modules', 'minecraft-data'))(version);
    const toClientTypes = mcData.protocol?.play?.toClient?.types;
    if (toClientTypes && !toClientTypes.packet_common_transfer) {
      toClientTypes.packet_common_transfer = [
        'container',
        [
          { name: 'host', type: 'string' },
          { name: 'port', type: 'varint' },
        ],
      ];
    }
  } catch (_) {}

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

  // Flag para saber se a desconexão foi intencional (pelo painel)
  let intentionalDisconnect = false;

  // Guarda referência para poder checar depois
  rt._setIntentional = () => { intentionalDisconnect = true; };

  // ── Velocity Transfer Packet ────────────────────────────────────────────────
  // Agora que o pacote está registrado via customPackets, o minecraft-protocol
  // consegue decodificá-lo e emite o evento 'transfer' com { host, port }.
  // Capturamos aqui e reconectamos o bot diretamente no novo backend.
  try {
    const rawClient = bot._client;
    if (rawClient) {
      rawClient.on('transfer', (packet) => {
        if (intentionalDisconnect) return;
        const newHost = packet.host || cfg.host;
        const newPort = packet.port || cfg.port;
        pushLog(id, `Transfer Velocity: indo para ${newHost}:${newPort}...`);
        // Fecha conexão atual de forma limpa; o end event reconecta
        try { rawClient.end('transfer'); } catch (_) {}
      });

      // Fallback para versões onde o ID do pacote pode ser diferente:
      // captura erros de parse e reconecta antes que o Velocity dê timeout
      rawClient.on('error', (err) => {
        if (intentionalDisconnect) return;
        const msg = String(err && err.message || '').toLowerCase();
        if (msg.includes('parse error') || msg.includes('packet') || msg.includes('decode')) {
          pushLog(id, `Erro de decode (Transfer?): ${err.message} — reconectando...`);
          try { rawClient.end('transfer'); } catch (_) {}
        }
      });
    }
  } catch (_) {}
  // ───────────────────────────────────────────────────────────────────────────

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
    if (intentionalDisconnect) return;

    // reason pode ser string JSON, string plana, ou já um objeto
    let msg = reason;
    let rawReason = reason;
    try {
      if (typeof reason === 'string') {
        const parsed = JSON.parse(reason);
        msg = parsed?.text || parsed?.translate || parsed?.extra?.[0]?.text || reason;
        rawReason = parsed;
      } else if (typeof reason === 'object' && reason !== null) {
        msg = reason.text || reason.translate || reason.extra?.[0]?.text || JSON.stringify(reason);
        rawReason = reason;
      }
    } catch (_) {}

    // Loga o reason bruto para facilitar debug
    pushLog(id, `[kicked raw] ${JSON.stringify(rawReason)}`);

    // Velocity/BungeeCord manda kick com mensagem de transfer — não é erro real
    const lower = String(msg).toLowerCase();
    const rawStr = JSON.stringify(rawReason).toLowerCase();
    const isTransfer =
      lower.includes('transfer') || lower.includes('moving') ||
      lower.includes('connecting') || lower.includes('please wait') ||
      rawStr.includes('transfer') || rawStr.includes('switchserver') ||
      rawStr.includes('connect_to');
    if (isTransfer) {
      pushLog(id, `Transfer de servidor detectado, reconectando...`);
      rt.client = null;
      rt.status = 'connecting';
      setTimeout(() => {
        if (!intentionalDisconnect && runtime[id]?.status === 'connecting') connectBot(id);
      }, 1500);
      return;
    }

    rt.status = 'offline';
    rt.client = null;
    pushLog(id, `Kickado: ${msg}`);
  });

  bot.on('error', (err) => {
    if (intentionalDisconnect || rt.status === 'offline' || rt.status === 'connecting') return;
    const msg = String(err && err.message || '').toLowerCase();
    // Erros de decode de pacote são tratados pelo handler do rawClient — ignorar aqui
    if (msg.includes('packet') || msg.includes('decode') || msg.includes('invalid data')) return;
    rt.status = 'error';
    rt.client = null;
    pushLog(id, `Erro: ${err.message}`);
  });

  bot.on('end', (reason) => {
    if (intentionalDisconnect) return;

    const lower = String(reason || '').toLowerCase();

    // Velocity transfer: reconecta automaticamente após breve delay
    const isTransfer = lower.includes('transfer') || lower.includes('switchproxycommand') ||
                       lower === '' || lower === 'socketclosed' || lower === 'end';

    if (isTransfer && rt.status !== 'offline') {
      pushLog(id, `Troca de servidor (${reason || 'transfer'}), reconectando em 1.5s...`);
      rt.client = null;
      rt.status = 'connecting';
      setTimeout(() => {
        // Só reconecta se ainda não foi desconectado manualmente
        if (!intentionalDisconnect && runtime[id]?.status === 'connecting') {
          connectBot(id);
        }
      }, 1500);
      return;
    }

    if (rt.status !== 'offline') {
      rt.status = 'offline';
      rt.client = null;
      pushLog(id, `Desconectado: ${reason || 'conexão encerrada'}`);
    }
  });
}

function disconnectBot(id) {
  const rt = getRuntime(id);
  // Sinaliza desconexão intencional antes do quit para ignorar eventos end/error
  if (rt._setIntentional) rt._setIntentional();
  if (rt.client) {
    try { rt.client.quit('Desconectado pelo painel'); } catch (_) {}
    rt.client = null;
  }
  rt.status = 'offline';
  rt._setIntentional = null;
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
    const nick = String(body.nick || DEFAULT_NICK).trim().slice(0, 16) || DEFAULT_NICK;

    // Avisa se já existe bot online com mesmo nick no mesmo servidor
    const conflict = botConfigs.find((b) =>
      b.host === host && b.port === (Number(body.port) || 25565) &&
      b.nick === nick && getRuntime(b.id).status === 'online'
    );
    if (conflict) {
      return json(res, 409, {
        ok: false,
        error: 'nick_conflict',
        message: `Já existe um bot online com o nick "${nick}" em ${host}. Use um nick diferente.`,
      });
    }

    const id = newId();
    const cfg = {
      id,
      label: String(body.label || host).trim(),
      nick,
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
