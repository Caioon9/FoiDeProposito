// F.D.P. Online — servidor sem dependências (Node 18+)
// Tempo real via Server-Sent Events; ações via POST /api/*.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const CARDS = require('./cards');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MIN_PLAYERS = 4;
const MAX_PLAYERS = 12;
const HAND = 10;
const REVEAL_PAUSE = 9000;
const JUDGE_TIMEOUT = 30000; // juiz desconectado há 30s: pula a rodada
const AWAY_TIMEOUT = 30000;  // jogador desconectado há 30s não segura a rodada

const rooms = new Map();

// ---------- utilidades ----------
const rid = (n = 12) => crypto.randomBytes(n).toString('hex');
function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do c = Array.from({ length: 4 }, () => A[crypto.randomInt(A.length)]).join('');
  while (rooms.has(c));
  return c;
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const cleanName = (n) => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 16);
const blanks = (text) => Math.max(1, (text.match(/_{2,}/g) || []).length);
// Endereços deste PC na rede local (para os amigos acessarem de outros computadores)
function lanUrls() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${PORT}`);
  }
  // Redes domésticas comuns primeiro (192.168.x.x), depois o resto
  return out.sort((a, b) => b.includes('://192.168.') - a.includes('://192.168.'));
}
function cleanLines(s, max) {
  return String(s || '')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim().slice(0, 160))
    .filter(Boolean)
    .slice(0, max);
}

// ---------- sala ----------
function createRoom() {
  const room = {
    code: newCode(),
    hostId: null,
    players: [],
    settings: { target: 5, infinite: false },
    custom: { black: [], white: [] },
    phase: 'lobby',
    round: 0,
    judgeId: null,
    black: null,
    swapped: false,
    submissions: [], // {pid, cards:[{id,text}]}
    winner: null,    // índice da resposta escolhida
    gameWinner: null,
    whiteDeck: [],
    whiteDiscard: [],
    blackDeck: [],
    blackDiscard: [],
    nextAt: 0,
    timer: null,
    feed: [],
    emptySince: null,
    phaseSince: 0,
  };
  rooms.set(room.code, room);
  return room;
}
function addPlayer(room, name) {
  const base = cleanName(name) || 'Jogador';
  let final = base;
  let k = 2;
  while (room.players.some((p) => p.name.toLowerCase() === final.toLowerCase())) final = `${base} ${k++}`;
  const p = {
    id: rid(6), token: rid(16), name: final, points: 0, hand: [],
    active: room.phase === 'lobby', clients: new Set(), connected: false, offSince: Date.now(),
  };
  room.players.push(p);
  if (!room.hostId) room.hostId = p.id;
  if (room.phase !== 'lobby' && room.phase !== 'gameOver') refill(room, p);
  return p;
}
const byId = (room, id) => room.players.find((p) => p.id === id);
function say(room, text, name = null) {
  room.feed.push({ t: Date.now(), name, text: String(text).slice(0, 240), sys: !name });
  if (room.feed.length > 80) room.feed.splice(0, room.feed.length - 80);
}
function clearTimer(room) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
}
function setPhase(room, phase) {
  room.phase = phase;
  room.phaseSince = Date.now();
}

// ---------- baralhos ----------
function buildDecks(room) {
  let n = 0;
  room.whiteDeck = shuffle([...CARDS.white, ...room.custom.white].map((text) => ({ id: 'w' + n++, text })));
  room.blackDeck = shuffle([...CARDS.black, ...room.custom.black].map((text) => ({ text, pick: blanks(text) })));
  room.whiteDiscard = [];
  room.blackDiscard = [];
}
function drawWhite(room) {
  if (!room.whiteDeck.length) {
    room.whiteDeck = shuffle(room.whiteDiscard);
    room.whiteDiscard = [];
    if (room.whiteDeck.length) say(room, 'O baralho branco acabou e foi reembaralhado.');
  }
  return room.whiteDeck.pop();
}
function drawBlack(room) {
  if (!room.blackDeck.length) {
    room.blackDeck = shuffle(room.blackDiscard);
    room.blackDiscard = [];
  }
  return room.blackDeck.pop();
}
function refill(room, p) {
  while (p.hand.length < HAND) {
    const c = drawWhite(room);
    if (!c) break;
    p.hand.push(c);
  }
}

// ---------- fluxo ----------
function startGame(room) {
  clearTimer(room);
  buildDecks(room);
  for (const p of room.players) {
    p.points = 0;
    p.hand = [];
    p.active = true;
    refill(room, p);
  }
  room.round = 0;
  room.gameWinner = null;
  room.judgeId = room.players[crypto.randomInt(room.players.length)].id;
  say(room, `Partida começou! ${room.settings.infinite ? 'Modo infinito.' : `Vence quem fizer ${room.settings.target} pontos.`}`);
  startRound(room, true);
}

function startRound(room, first = false) {
  clearTimer(room);
  // Cartas usadas vão para o descarte; todos completam a mão
  for (const s of room.submissions) room.whiteDiscard.push(...s.cards);
  if (room.black) room.blackDiscard.push(room.black);
  room.submissions = [];
  room.black = null;
  room.winner = null;
  room.swapped = false;
  for (const p of room.players) {
    p.active = true;
    refill(room, p);
  }
  if (!first) {
    const i = room.players.findIndex((p) => p.id === room.judgeId);
    room.judgeId = room.players[(i + 1) % room.players.length].id;
  }
  room.round += 1;
  setPhase(room, 'swap');
  say(room, `Rodada ${room.round}: ${byId(room, room.judgeId).name} é o juiz.`);
}

const answerers = (room) => room.players.filter((p) => p.active && p.id !== room.judgeId);

function revealBlack(room) {
  room.black = drawBlack(room);
  setPhase(room, 'answering');
}

function maybeCloseAnswers(room, force = false) {
  if (room.phase !== 'answering') return;
  const now = Date.now();
  const pending = answerers(room).filter(
    (p) => !room.submissions.some((s) => s.pid === p.id) && (p.connected || now - p.offSince < AWAY_TIMEOUT)
  );
  if (pending.length && !force) return;
  if (!room.submissions.length) return;
  shuffle(room.submissions); // anonimato: ordem aleatória, sem dono visível
  setPhase(room, 'judging');
}

function pickWinner(room, index) {
  const s = room.submissions[index];
  if (!s) throw new Error('Resposta inválida.');
  room.winner = index;
  const w = byId(room, s.pid);
  if (w) {
    w.points += 1;
    say(room, `${byId(room, room.judgeId).name} escolheu a resposta de ${w.name}. +1 ponto!`);
  }
  if (w && !room.settings.infinite && w.points >= room.settings.target) {
    room.gameWinner = w.id;
    setPhase(room, 'gameOver');
    say(room, `${w.name} venceu a partida! O maior F.D.P. da mesa.`);
    return;
  }
  setPhase(room, 'reveal');
  room.nextAt = Date.now() + REVEAL_PAUSE;
  room.timer = setTimeout(() => {
    room.timer = null;
    if (room.phase !== 'reveal') return;
    startRound(room);
    broadcast(room);
  }, REVEAL_PAUSE);
}

function skipRound(room, why) {
  // Devolve as respostas para a mão de quem enviou e passa o juiz adiante
  for (const s of room.submissions) {
    const p = byId(room, s.pid);
    if (p) p.hand.push(...s.cards);
    else room.whiteDiscard.push(...s.cards);
  }
  room.submissions = [];
  say(room, why);
  startRound(room);
}

function removePlayer(room, p) {
  const wasJudge = room.judgeId === p.id;
  const idx = room.players.indexOf(p);
  room.whiteDiscard.push(...p.hand);
  const sub = room.submissions.findIndex((s) => s.pid === p.id);
  if (sub >= 0 && room.phase !== 'reveal') {
    room.whiteDiscard.push(...room.submissions[sub].cards);
    room.submissions.splice(sub, 1);
  }
  room.players = room.players.filter((x) => x !== p);
  for (const res of p.clients) send(res, { kicked: true });
  if (room.hostId === p.id) room.hostId = room.players[0] ? room.players[0].id : null;
  if (!room.players.length) {
    clearTimer(room);
    rooms.delete(room.code);
    return;
  }
  const inGame = room.phase !== 'lobby' && room.phase !== 'gameOver';
  if (inGame && room.players.length < 3) {
    clearTimer(room);
    setPhase(room, 'lobby');
    room.submissions = [];
    room.black = null;
    say(room, 'Ficou gente de menos para continuar. Voltamos para o lobby.');
    return;
  }
  if (inGame && wasJudge) {
    // o próximo da lista (que agora ocupa a posição do juiz) assume
    room.judgeId = room.players[(idx - 1 + room.players.length) % room.players.length].id;
    if (room.phase !== 'reveal') skipRound(room, 'O juiz saiu. Nova rodada.');
    return;
  }
  if (room.phase === 'judging' && !room.submissions.length) skipRound(room, 'Não sobrou resposta. Nova rodada.');
  maybeCloseAnswers(room);
}

// ---------- visão por jogador ----------
function viewFor(room, me) {
  const showOwners = room.phase === 'reveal' || room.phase === 'gameOver';
  const mine = room.submissions.find((s) => s.pid === me.id);
  return {
    code: room.code,
    me: me.id,
    hostId: room.hostId,
    phase: room.phase,
    settings: room.settings,
    customCount: { black: room.custom.black.length, white: room.custom.white.length },
    custom: room.hostId === me.id ? room.custom : null,
    round: room.round,
    judgeId: room.judgeId,
    black: room.black,
    swapped: room.swapped,
    submittedCount: room.submissions.length,
    expected: answerers(room).length,
    // Na hora do julgamento ninguém sabe de quem é cada resposta
    submissions:
      room.phase === 'judging' || showOwners
        ? room.submissions.map((s) => ({ cards: s.cards.map((c) => c.text), pid: showOwners ? s.pid : null }))
        : [],
    winner: room.winner,
    gameWinner: room.gameWinner,
    mySubmission: mine ? mine.cards.map((c) => c.text) : null,
    nextIn: Math.max(0, room.nextAt - Date.now()),
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      points: p.points,
      connected: p.connected,
      active: p.active,
      submitted: room.submissions.some((s) => s.pid === p.id),
    })),
    hand: me.hand,
    feed: room.feed.slice(-50),
  };
}
function send(res, data) {
  try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {}
}
function broadcast(room) {
  for (const p of room.players) {
    if (!p.clients.size) continue;
    const v = viewFor(room, p);
    for (const res of p.clients) send(res, v);
  }
}

// ---------- ações ----------
function handleAction(room, p, body) {
  const isHost = room.hostId === p.id;
  const isJudge = room.judgeId === p.id;
  switch (body.type) {
    case 'settings': {
      if (!isHost || (room.phase !== 'lobby' && room.phase !== 'gameOver')) throw new Error('Só o anfitrião muda as regras, fora da partida.');
      const t = Math.round(Number(body.target));
      if (t >= 1 && t <= 30) room.settings.target = t;
      if (typeof body.infinite === 'boolean') room.settings.infinite = body.infinite;
      break;
    }
    case 'custom':
      if (!isHost || (room.phase !== 'lobby' && room.phase !== 'gameOver')) throw new Error('Só o anfitrião edita as cartas, fora da partida.');
      room.custom.black = cleanLines(body.black, 200).map((l) => (/_{2,}/.test(l) ? l.replace(/_{2,}/g, '____') : l));
      room.custom.white = cleanLines(body.white, 500);
      say(room, `Cartas da casa: ${room.custom.black.length} pretas e ${room.custom.white.length} brancas.`);
      break;
    case 'start':
      if (!isHost) throw new Error('Só o anfitrião pode começar.');
      if (room.phase !== 'lobby' && room.phase !== 'gameOver') throw new Error('A partida já está rolando.');
      if (room.players.length < MIN_PLAYERS) throw new Error(`Precisa de pelo menos ${MIN_PLAYERS} jogadores.`);
      startGame(room);
      break;
    case 'lobby':
      if (!isHost || room.phase !== 'gameOver') throw new Error('Ação inválida.');
      setPhase(room, 'lobby');
      room.submissions = [];
      room.black = null;
      for (const pl of room.players) { pl.points = 0; pl.hand = []; pl.active = true; }
      break;
    case 'swap': {
      // Regra do juiz: antes de revelar a pergunta, pode trocar cartas da mão
      if (room.phase !== 'swap' || !isJudge) throw new Error('Só o juiz troca cartas, antes de revelar a pergunta.');
      if (room.swapped) throw new Error('Você já trocou cartas nesta rodada.');
      const ids = new Set(Array.isArray(body.cards) ? body.cards : []);
      const out = p.hand.filter((c) => ids.has(c.id));
      if (!out.length) throw new Error('Escolha as cartas que quer trocar.');
      p.hand = p.hand.filter((c) => !ids.has(c.id));
      room.whiteDiscard.push(...out);
      refill(room, p);
      room.swapped = true;
      say(room, `O juiz trocou ${out.length} carta${out.length > 1 ? 's' : ''}.`);
      break;
    }
    case 'reveal':
      if (room.phase !== 'swap' || !isJudge) throw new Error('Só o juiz revela a pergunta.');
      revealBlack(room);
      break;
    case 'submit': {
      if (room.phase !== 'answering') throw new Error('Não é hora de responder.');
      if (isJudge) throw new Error('O juiz não responde.');
      if (!p.active) throw new Error('Você entra na próxima rodada.');
      if (room.submissions.some((s) => s.pid === p.id)) throw new Error('Você já enviou.');
      const ids = Array.isArray(body.cards) ? body.cards : [];
      if (ids.length !== room.black.pick || new Set(ids).size !== ids.length)
        throw new Error(`Escolha ${room.black.pick} carta${room.black.pick > 1 ? 's' : ''}.`);
      const cards = ids.map((id) => p.hand.find((c) => c.id === id));
      if (cards.some((c) => !c)) throw new Error('Carta inválida.');
      p.hand = p.hand.filter((c) => !ids.includes(c.id));
      room.submissions.push({ pid: p.id, cards });
      maybeCloseAnswers(room);
      break;
    }
    case 'force':
      if (room.phase !== 'answering' || (!isJudge && !isHost)) throw new Error('Ação inválida.');
      if (room.submissions.length < 1) throw new Error('Ninguém respondeu ainda.');
      say(room, 'O juiz cansou de esperar e seguiu com as respostas que chegaram.');
      maybeCloseAnswers(room, true);
      break;
    case 'pick':
      if (room.phase !== 'judging' || !isJudge) throw new Error('Só o juiz escolhe.');
      pickWinner(room, Number(body.index));
      break;
    case 'next':
      if (room.phase !== 'reveal' || (!isHost && !isJudge)) throw new Error('Ação inválida.');
      startRound(room);
      break;
    case 'kick': {
      if (!isHost) throw new Error('Só o anfitrião remove jogadores.');
      const t = byId(room, body.pid);
      if (!t || t.id === p.id) throw new Error('Jogador inválido.');
      say(room, `${t.name} foi removido da sala.`);
      removePlayer(room, t);
      break;
    }
    case 'leave':
      say(room, `${p.name} saiu.`);
      removePlayer(room, p);
      break;
    case 'chat': {
      const text = String(body.text || '').trim().slice(0, 200);
      if (text) say(room, text, p.name);
      break;
    }
    default:
      throw new Error('Ação desconhecida.');
  }
}

// ---------- HTTP ----------
function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => {
      s += c;
      if (s.length > 100000) { reject(new Error('Conteúdo grande demais.')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(s ? JSON.parse(s) : {}); } catch { reject(new Error('JSON inválido')); }
    });
  });
}
function auth(q) {
  const room = rooms.get(String(q.room || '').toUpperCase());
  if (!room) return {};
  const p = byId(room, q.pid);
  if (!p || p.token !== q.token) return { room };
  return { room, p };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return fs.createReadStream(path.join(PUBLIC, 'index.html')).pipe(res);
    }

    if (req.method === 'GET' && url.pathname === '/api/info') return json(res, 200, { lan: lanUrls() });

    if (req.method === 'GET' && url.pathname === '/events') {
      const { room, p } = auth(Object.fromEntries(url.searchParams));
      if (!p) return json(res, 404, { error: 'Sessão não encontrada.' });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 2000\n\n');
      p.clients.add(res);
      const wasOff = !p.connected;
      p.connected = true;
      room.emptySince = null;
      if (wasOff) broadcast(room);
      else send(res, viewFor(room, p));
      req.on('close', () => {
        p.clients.delete(res);
        if (!p.clients.size) {
          p.connected = false;
          p.offSince = Date.now();
          if (rooms.get(room.code) === room) broadcast(room);
        }
      });
      return;
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      const body = await readBody(req);
      const route = url.pathname.slice(5);

      if (route === 'create') {
        const room = createRoom();
        const p = addPlayer(room, body.name);
        say(room, `${p.name} criou a sala.`);
        return json(res, 200, { room: room.code, pid: p.id, token: p.token });
      }
      if (route === 'join') {
        const room = rooms.get(String(body.room || '').trim().toUpperCase());
        if (!room) return json(res, 404, { error: 'Sala não encontrada. Confira o código.' });
        if (room.players.length >= MAX_PLAYERS) return json(res, 409, { error: `A sala está cheia (${MAX_PLAYERS} jogadores).` });
        const p = addPlayer(room, body.name);
        say(room, `${p.name} entrou${p.active ? '' : ' e joga a partir da próxima rodada'}.`);
        broadcast(room);
        return json(res, 200, { room: room.code, pid: p.id, token: p.token });
      }
      if (route === 'check') {
        const { p } = auth(body);
        return json(res, p ? 200 : 404, { ok: !!p });
      }
      if (route === 'action') {
        const { room, p } = auth(body);
        if (!p) return json(res, 404, { error: 'Sessão expirada. Entre de novo.' });
        try {
          handleAction(room, p, body);
        } catch (e) {
          return json(res, 400, { error: e.message });
        }
        if (rooms.get(room.code) === room) broadcast(room);
        return json(res, 200, { ok: true });
      }
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Não encontrado');
  } catch (e) {
    json(res, 400, { error: e.message || 'Erro' });
  }
});

// Manutenção: heartbeat, juiz ausente, jogadores ausentes, anfitrião ausente e limpeza
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    for (const p of room.players) for (const res of p.clients) {
      try { res.write(': ping\n\n'); } catch {}
    }
    let changed = false;
    const judge = byId(room, room.judgeId);
    const judgePhase = ['swap', 'answering', 'judging'].includes(room.phase);
    if (judgePhase && judge && !judge.connected && now - Math.max(judge.offSince, room.phaseSince) > JUDGE_TIMEOUT) {
      skipRound(room, `${judge.name} (juiz) caiu da conexão. Pulando para a próxima rodada.`);
      changed = true;
    }
    if (room.phase === 'answering') {
      const before = room.phase;
      maybeCloseAnswers(room);
      if (room.phase !== before) changed = true;
    }
    const host = byId(room, room.hostId);
    if (host && !host.connected && now - host.offSince > 30000) {
      const other = room.players.find((p) => p.connected);
      if (other) {
        room.hostId = other.id;
        say(room, `${other.name} agora é o anfitrião.`);
        changed = true;
      }
    }
    if (changed) broadcast(room);
    if (!room.players.some((p) => p.connected)) {
      room.emptySince = room.emptySince || now;
      if (now - room.emptySince > 2 * 60 * 60 * 1000) {
        clearTimer(room);
        rooms.delete(room.code);
      }
    }
  }
}, 5000);

server.listen(PORT, () => {
  console.log(`F.D.P. Online rodando!`);
  console.log(`  Neste computador:     http://localhost:${PORT}`);
  for (const u of lanUrls()) console.log(`  Outros computadores:  ${u}`);
});
