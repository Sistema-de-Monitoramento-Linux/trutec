// ============================================================================
// TRUCO PAULISTA ONLINE — server.js
// Node.js + Express + Socket.io
// ============================================================================

const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// ---------------------------------------------------------------------------
// CORS: o frontend agora roda em outro domínio (ex: Vercel), então liberamos
// explicitamente as origens permitidas via variável de ambiente ALLOWED_ORIGINS
// (lista separada por vírgula). Em branco = libera geral (bom para testar).
// Exemplo no Render: ALLOWED_ORIGINS=https://seu-jogo.vercel.app,http://localhost:5500
// ---------------------------------------------------------------------------
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

function corsOriginCheck(origin, callback) {
  if (!origin) return callback(null, true); // requests sem origin (curl, health check)
  if (allowedOrigins.length === 0) return callback(null, true); // libera tudo se não configurado
  if (allowedOrigins.includes(origin)) return callback(null, true);
  callback(new Error('Origem não permitida pelo CORS: ' + origin));
}

app.use(cors({ origin: corsOriginCheck }));

const io = new Server(server, {
  cors: {
    origin: allowedOrigins.length ? allowedOrigins : '*',
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;

// Serve os arquivos estáticos do frontend só como conveniência para testar
// localmente sem precisar rodar dois servidores. Em produção o frontend fica
// hospedado separadamente na Vercel.
app.use(express.static(path.join(__dirname, '..', 'frontend')));
app.get('/health', (req, res) => res.json({ ok: true }));

// ---------------------------------------------------------------------------
// Constantes do jogo
// ---------------------------------------------------------------------------

const SUITS = ['ouros', 'espadas', 'copas', 'paus']; // diamante, espada, copas, paus
const SUIT_SYMBOLS = { ouros: '♦', espadas: '♠', copas: '♥', paus: '♣' };
const SUIT_COLOR = { ouros: 'red', espadas: 'black', copas: 'red', paus: 'black' };
// Ordem de força das cartas (sem manilha), do mais fraco pro mais forte
const RANK_ORDER = ['4', '5', '6', '7', 'Q', 'J', 'K', 'A', '2', '3'];
// Força da manilha por naipe (Truco Paulista): ouros < espadas < copas < paus
const MANILHA_SUIT_STRENGTH = { ouros: 0, espadas: 1, copas: 2, paus: 3 };

const STAKE_SEQUENCE = [1, 3, 6, 9, 12];
const STAKE_LABEL = { 1: 'valendo 1', 3: 'TRUCO', 6: 'SEIS', 9: 'NOVE', 12: 'DOZE' };
const NEXT_CALL_NAME = { 1: 'truco', 3: 'seis', 6: 'nove', 9: 'doze' };

// ---------------------------------------------------------------------------
// Estado em memória
// ---------------------------------------------------------------------------

/** @type {Map<string, Room>} */
const rooms = new Map();

function genRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function buildDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANK_ORDER) {
      deck.push({ id: `${rank}-${suit}`, rank, suit });
    }
  }
  return deck;
}

// Personagem é um PNG (dataURL) desenhado no cliente. Validação simples pra
// evitar lixo/abuso: só aceita dataURL de PNG e limita o tamanho.
function sanitizeCharacter(character) {
  if (typeof character !== 'string') return null;
  if (!character.startsWith('data:image/png;base64,')) return null;
  if (character.length > 400000) return null; // ~300KB, generoso pra um canvas 500x500
  return character;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function rankIndex(rank) {
  return RANK_ORDER.indexOf(rank);
}

function manilhaRankFromVira(viraRank) {
  const idx = rankIndex(viraRank);
  return RANK_ORDER[(idx + 1) % RANK_ORDER.length];
}

function cardStrength(card, manilhaRank) {
  if (card.rank === manilhaRank) {
    return 100 + MANILHA_SUIT_STRENGTH[card.suit];
  }
  return rankIndex(card.rank);
}

// ---------------------------------------------------------------------------
// Sala / Jogo
// ---------------------------------------------------------------------------

class Room {
  constructor(code, mode, isPublic, hostName) {
    this.code = code;
    this.mode = mode; // '1v1' or '2v2'
    this.maxPlayers = mode === '1v1' ? 2 : 4;
    this.isPublic = isPublic;
    this.players = []; // { id (socketId), name, seat, team, connected, hand: [] }
    this.started = false;
    this.chatLog = [];
    this.characterPhaseTimer = null; // setTimeout ativo durante os 45s de "desenhar o personagem"

    // Estado de jogo (preenchido em startGame)
    this.deck = [];
    this.vira = null;
    this.manilhaRank = null;
    this.dealerSeat = -1;
    this.turnSeat = -1;
    this.leaderSeat = -1; // quem abre a rodada atual (trick)
    this.table = []; // { seat, card, hidden }
    this.tricks = []; // resultado de cada vaza: { winnerTeam: 0|1|null }
    this.score = [0, 0];
    this.stake = 1;
    this.lastRaiserTeam = null; // time que fez a última aposta (não pode aumentar de novo sem resposta)
    this.pendingCall = null; // { level, callingTeam, respondingTeam }
    this.maoNumber = 0;
    this.gameOver = false;
    this.hiddenCardBySeat = {}; // seat -> true (jogou "escondida", visível só ao dono até revelar)
  }

  get teamsCount() {
    return this.mode === '2v2' ? 2 : 2; // sempre 2 times (1v1: 1 jogador por time)
  }

  seatTeam(seat) {
    // O time de cada assento é o que está gravado no jogador (player.team).
    // Por padrão, ao entrar na sala, o jogador recebe seat % 2 (ver
    // joinRoomInternal), mas no modo 2v2 o host pode reorganizar as duplas
    // livremente antes de iniciar a partida (ver evento 'set_player_team').
    const p = this.playerBySeat(seat);
    return p ? p.team : seat % 2;
  }

  // Quantos jogadores tem em cada time no momento (só faz sentido no 2v2).
  teamCounts() {
    const counts = [0, 0];
    for (const p of this.players) counts[p.team]++;
    return counts;
  }

  // Duplas prontas pra iniciar: no 2v2, exatamente 2 jogadores por time.
  teamsReady() {
    if (this.mode !== '2v2') return true;
    const [a, b] = this.teamCounts();
    return a === 2 && b === 2;
  }

  publicSummary() {
    return {
      code: this.code,
      mode: this.mode,
      players: this.players.length,
      maxPlayers: this.maxPlayers,
      started: this.started
    };
  }

  lobbyState() {
    return {
      code: this.code,
      mode: this.mode,
      isPublic: this.isPublic,
      maxPlayers: this.maxPlayers,
      started: this.started,
      // Sala cheia, com duplas fechadas (2v2) e ainda não iniciada = pronta
      // pro host apertar "Iniciar".
      canStart: !this.started && this.players.length === this.maxPlayers && this.teamsReady(),
      teamsReady: this.teamsReady(),
      players: this.players.map(p => ({
        seat: p.seat, name: p.name, team: p.team, connected: p.connected, character: p.character || null
      }))
    };
  }

  otherSeats(seat) {
    return this.players.filter(p => p.seat !== seat);
  }

  playerBySeat(seat) {
    return this.players.find(p => p.seat === seat);
  }

  playerBySocket(id) {
    return this.players.find(p => p.id === id);
  }

  teamName(team) {
    return this.mode === '1v1'
      ? this.playerBySeat(team) ? this.playerBySeat(team).name : `Time ${team + 1}`
      : `Dupla ${team + 1}`;
  }

  // -------------------------------------------------------------------
  startGame() {
    this.started = true;
    this.score = [0, 0];
    this.dealerSeat = 0;
    this.startMao();
  }

  startMao() {
    this.maoNumber++;
    this.deck = shuffle(buildDeck());
    this.table = [];
    this.tricks = [];
    this.stake = 1;
    this.lastRaiserTeam = null;
    this.pendingCall = null;
    this.hiddenCardBySeat = {};

    const n = this.players.length;
    for (const p of this.players) p.hand = [];
    for (let i = 0; i < 3; i++) {
      for (const p of this.players) {
        p.hand.push(this.deck.pop());
      }
    }
    this.vira = this.deck.pop();
    this.manilhaRank = manilhaRankFromVira(this.vira.rank);

    this.leaderSeat = (this.dealerSeat + 1) % n;
    this.turnSeat = this.leaderSeat;
  }

  advanceDealer() {
    this.dealerSeat = (this.dealerSeat + 1) % this.players.length;
  }

  currentTrickIndex() {
    return this.tricks.length;
  }

  // Joga uma carta do jogador `seat`
  playCard(seat, cardId, hidden) {
    const player = this.playerBySeat(seat);
    const idx = player.hand.findIndex(c => c.id === cardId);
    if (idx === -1) return { error: 'Carta não encontrada na mão.' };
    const [card] = player.hand.splice(idx, 1);
    this.table.push({ seat, card, hidden: !!hidden });
    if (hidden) this.hiddenCardBySeat[seat] = true;

    const n = this.players.length;
    const playedThisTrick = this.table.length - this.trickStartIndex();
    if (playedThisTrick >= n) {
      return this.resolveTrick();
    }
    this.turnSeat = (seat + 1) % n;
    return { ok: true };
  }

  trickStartIndex() {
    // índice em this.table onde começou a vaza atual
    return this.tricks.length * this.players.length;
  }

  resolveTrick() {
    const n = this.players.length;
    const startIdx = this.trickStartIndex();
    const plays = this.table.slice(startIdx, startIdx + n);

    let best = null;
    let bestStrength = -1;
    let tie = false;
    for (const play of plays) {
      const s = cardStrength(play.card, this.manilhaRank);
      if (s > bestStrength) {
        bestStrength = s;
        best = play;
        tie = false;
      } else if (s === bestStrength) {
        tie = true;
      }
    }

    const winnerTeam = tie ? null : this.seatTeam(best.seat);
    const winnerSeat = tie ? null : best.seat;
    this.tricks.push({ winnerTeam, winnerSeat, tie, plays });

    // checa se time já fechou a mão (2 vazas ganhas)
    const wins = [0, 0];
    for (const t of this.tricks) {
      if (!t.tie && t.winnerTeam !== null) wins[t.winnerTeam]++;
    }

    let maoWinnerTeam = null;
    if (wins[0] >= 2) maoWinnerTeam = 0;
    else if (wins[1] >= 2) maoWinnerTeam = 1;
    else if (this.tricks.length >= 3) {
      // 3 vazas jogadas, decide por regra de empates
      if (this.tricks[0].tie) {
        // se a 1a empatou, quem ganha a 2a leva a mão; se a 2a também empatar, decide a 3a
        if (!this.tricks[1].tie) maoWinnerTeam = this.tricks[1].winnerTeam;
        else if (!this.tricks[2].tie) maoWinnerTeam = this.tricks[2].winnerTeam;
        else maoWinnerTeam = this.seatTeam(this.leaderSeat); // tudo empatou: mão do líder leva
      } else if (wins[0] === wins[1]) {
        // empate de vazas ganhas: quem ganhou a primeira vaza leva
        maoWinnerTeam = this.tricks[0].winnerTeam;
      } else {
        maoWinnerTeam = wins[0] > wins[1] ? 0 : 1;
      }
    }

    if (maoWinnerTeam !== null) {
      return { ok: true, trickResult: this.tricks[this.tricks.length - 1], maoOver: true, maoWinnerTeam };
    }

    // próxima vaza: lidera quem ganhou (ou o mesmo líder se empatou)
    this.leaderSeat = tie ? this.leaderSeat : winnerSeat;
    this.turnSeat = this.leaderSeat;
    return { ok: true, trickResult: this.tricks[this.tricks.length - 1], maoOver: false };
  }

  finishMao(winnerTeam, points) {
    this.score[winnerTeam] += points;
    this.advanceDealer();
    const isGameOver = this.score[0] >= 12 || this.score[1] >= 12;
    if (isGameOver) this.gameOver = true;
    return isGameOver;
  }

  // --- Truco / aumento de aposta ---
  requestCall(seat, level) {
    const team = this.seatTeam(seat);
    if (this.pendingCall) return { error: 'Já existe um pedido pendente.' };
    if (this.lastRaiserTeam === team) return { error: 'Aguarde a resposta do adversário.' };

    const currentStakeIdx = STAKE_SEQUENCE.indexOf(this.stake);
    const expectedNext = STAKE_SEQUENCE[currentStakeIdx + 1];
    const levelValue = { truco: 3, seis: 6, nove: 9, doze: 12 }[level];
    if (levelValue !== expectedNext) return { error: 'Chamada inválida neste momento.' };

    const respondingTeam = team === 0 ? 1 : 0;
    this.pendingCall = { level, value: levelValue, callingTeam: team, respondingTeam, previousStake: this.stake };
    return { ok: true };
  }

  respondCall(seat, action) {
    if (!this.pendingCall) return { error: 'Não há pedido pendente.' };
    const team = this.seatTeam(seat);
    if (team !== this.pendingCall.respondingTeam) return { error: 'Você não pode responder a esta chamada.' };

    if (action === 'aceitar') {
      this.stake = this.pendingCall.value;
      this.lastRaiserTeam = this.pendingCall.callingTeam;
      this.pendingCall = null;
      return { ok: true, accepted: true };
    }
    if (action === 'fugir') {
      const winnerTeam = this.pendingCall.callingTeam;
      const points = this.pendingCall.previousStake;
      this.pendingCall = null;
      return { ok: true, ran: true, winnerTeam, points };
    }
    if (action === 'aumentar') {
      // Aceita a resposta como um novo aumento imediato (vira o "calling team")
      const currentStakeIdx = STAKE_SEQUENCE.indexOf(this.pendingCall.value);
      const nextValue = STAKE_SEQUENCE[currentStakeIdx + 1];
      if (!nextValue) return { error: 'Não é possível aumentar além de doze.' };
      const newCallingTeam = team;
      const newRespondingTeam = this.pendingCall.callingTeam;
      const nextLevel = NEXT_CALL_NAME[this.pendingCall.value];
      this.pendingCall = {
        level: nextLevel, value: nextValue, callingTeam: newCallingTeam,
        respondingTeam: newRespondingTeam, previousStake: this.pendingCall.value
      };
      return { ok: true, reraised: true };
    }
    return { error: 'Ação inválida.' };
  }

  // Um jogador foge da mão sem pedido pendente (correr direto)
  runAway(seat) {
    const team = this.seatTeam(seat);
    const winnerTeam = team === 0 ? 1 : 0;
    return { winnerTeam, points: this.stake };
  }

  redactedStateFor(viewerSeat) {
    const n = this.players.length;
    return {
      code: this.code,
      mode: this.mode,
      maoNumber: this.maoNumber,
      vira: this.vira,
      manilhaRank: this.manilhaRank,
      dealerSeat: this.dealerSeat,
      turnSeat: this.turnSeat,
      leaderSeat: this.leaderSeat,
      score: this.score,
      stake: this.stake,
      stakeLabel: STAKE_LABEL[this.stake],
      pendingCall: this.pendingCall,
      gameOver: this.gameOver,
      players: this.players.map(p => ({
        seat: p.seat,
        name: p.name,
        team: p.team,
        connected: p.connected,
        character: p.character || null,
        cardsLeft: p.hand.length,
        hand: p.seat === viewerSeat ? p.hand : undefined
      })),
      table: this.table.map(play => {
        if (play.hidden && play.seat !== viewerSeat && !play.revealed) {
          return { seat: play.seat, hidden: true };
        }
        return { seat: play.seat, card: play.card, hidden: !!play.hidden };
      }),
      tricksPlayed: this.tricks.length
    };
  }

  broadcastState(io) {
    for (const p of this.players) {
      io.to(p.id).emit('state_update', this.redactedStateFor(p.seat));
    }
  }
}

// ---------------------------------------------------------------------------
// Socket.io
// ---------------------------------------------------------------------------

io.on('connection', (socket) => {
  let currentRoomCode = null;

  function room() {
    return currentRoomCode ? rooms.get(currentRoomCode) : null;
  }

  socket.on('create_room', ({ name, mode, isPublic, character }, cb) => {
    try {
      mode = mode === '2v2' ? '2v2' : '1v1';
      const code = genRoomCode();
      const r = new Room(code, mode, !!isPublic, name);
      rooms.set(code, r);
      const player = joinRoomInternal(r, socket, name || 'Jogador', character);
      currentRoomCode = code;
      cb && cb({ ok: true, code, seat: player.seat });
      io.to(code).emit('lobby_update', r.lobbyState());
    } catch (e) {
      cb && cb({ ok: false, error: e.message });
    }
  });

  socket.on('join_room', ({ code, name, character }, cb) => {
    code = (code || '').toUpperCase().trim();
    const r = rooms.get(code);
    if (!r) return cb && cb({ ok: false, error: 'Sala não encontrada.' });
    if (r.players.length >= r.maxPlayers) return cb && cb({ ok: false, error: 'Sala cheia.' });
    if (r.started) return cb && cb({ ok: false, error: 'Partida já começou.' });

    const player = joinRoomInternal(r, socket, name || 'Jogador', character);
    currentRoomCode = code;
    cb && cb({ ok: true, code, seat: player.seat });
    io.to(code).emit('lobby_update', r.lobbyState());
    // A partida não começa mais sozinha ao encher a mesa — o host (assento 0)
    // aperta "Iniciar partida" quando quiser (ver evento 'start_game').
  });

  socket.on('update_character', ({ character }) => {
    const r = room();
    if (!r) return;
    const player = r.playerBySocket(socket.id);
    if (!player) return;
    player.character = sanitizeCharacter(character);
    io.to(r.code).emit('lobby_update', r.lobbyState());
  });

  socket.on('list_public_rooms', (cb) => {
    const list = Array.from(rooms.values())
      .filter(r => r.isPublic && !r.started && r.players.length < r.maxPlayers)
      .map(r => r.publicSummary());
    cb && cb(list);
  });

  socket.on('quick_join', ({ name, mode, character }, cb) => {
    mode = mode === '2v2' ? '2v2' : '1v1';
    let r = Array.from(rooms.values()).find(
      x => x.isPublic && !x.started && x.mode === mode && x.players.length < x.maxPlayers
    );
    if (!r) {
      const code = genRoomCode();
      r = new Room(code, mode, true, name);
      rooms.set(code, r);
    }
    const player = joinRoomInternal(r, socket, name || 'Jogador', character);
    currentRoomCode = r.code;
    cb && cb({ ok: true, code: r.code, seat: player.seat });
    io.to(r.code).emit('lobby_update', r.lobbyState());
    // Idem: sem auto-start, o host clica em "Iniciar partida".
  });

  socket.on('start_game', (cb) => {
    const r = room();
    if (!r) return cb && cb({ ok: false, error: 'Sala não encontrada.' });
    const player = r.playerBySocket(socket.id);
    if (!player) return cb && cb({ ok: false, error: 'Você não está nesta sala.' });
    if (player.seat !== 0) return cb && cb({ ok: false, error: 'Só o host pode iniciar a partida.' });
    if (r.started) return cb && cb({ ok: false, error: 'A partida já começou.' });
    if (r.characterPhaseTimer) return cb && cb({ ok: false, error: 'A partida já está começando.' });
    if (r.players.length < r.maxPlayers) return cb && cb({ ok: false, error: 'Aguardando mais jogadores entrarem.' });
    if (!r.teamsReady()) return cb && cb({ ok: false, error: 'Ajuste as duplas (2 jogadores em cada) antes de iniciar.' });

    // Antes de começar a valer, todo mundo tem alguns segundos pra desenhar
    // (ou ajustar) o personagem. Só depois desse tempo a mão é distribuída.
    const CHARACTER_PHASE_MS = 45000;
    io.to(r.code).emit('character_phase_start', { durationMs: CHARACTER_PHASE_MS });
    r.characterPhaseTimer = setTimeout(() => {
      r.characterPhaseTimer = null;
      if (rooms.get(r.code) !== r) return; // sala foi removida nesse meio tempo
      r.startGame();
      r.players.forEach(p => io.to(p.id).emit('game_start', r.redactedStateFor(p.seat)));
      r.broadcastState(io);
    }, CHARACTER_PHASE_MS);

    cb && cb({ ok: true });
  });

  // Host escolhe as duplas no 2v2, antes de iniciar a partida: arrasta/toca
  // pra mover um jogador entre "Dupla 1" e "Dupla 2".
  socket.on('set_player_team', ({ seat, team }, cb) => {
    const r = room();
    if (!r) return cb && cb({ ok: false, error: 'Sala não encontrada.' });
    const host = r.playerBySocket(socket.id);
    if (!host || host.seat !== 0) return cb && cb({ ok: false, error: 'Só o host pode escolher as duplas.' });
    if (r.started) return cb && cb({ ok: false, error: 'A partida já começou.' });
    if (r.mode !== '2v2') return cb && cb({ ok: false, error: 'Só é possível escolher duplas no modo 2v2.' });
    if (team !== 0 && team !== 1) return cb && cb({ ok: false, error: 'Dupla inválida.' });
    const target = r.playerBySeat(seat);
    if (!target) return cb && cb({ ok: false, error: 'Jogador não encontrado.' });

    target.team = team;
    io.to(r.code).emit('lobby_update', r.lobbyState());
    cb && cb({ ok: true });
  });

  function joinRoomInternal(r, socket, name, character) {
    const seat = r.players.length;
    const team = r.seatTeam(seat);
    const player = { id: socket.id, name, seat, team, connected: true, hand: [], character: sanitizeCharacter(character) };
    r.players.push(player);
    socket.join(r.code);
    return player;
  }

  socket.on('play_card', ({ cardId, hidden }) => {
    const r = room();
    if (!r || !r.started || r.gameOver) return;
    const player = r.playerBySocket(socket.id);
    if (!player) return;
    if (r.turnSeat !== player.seat) return socket.emit('error_message', 'Não é sua vez.');
    if (r.pendingCall) return socket.emit('error_message', 'Responda o pedido de truco primeiro.');

    const result = r.playCard(player.seat, cardId, hidden);
    if (result.error) return socket.emit('error_message', result.error);

    if (result.trickResult) {
      // revela cartas escondidas ao fim da vaza
      const startIdx = r.trickStartIndex() - r.players.length;
      for (const play of r.table) play.revealed = true;
      io.to(r.code).emit('trick_result', {
        winnerSeat: result.trickResult.winnerSeat,
        winnerTeam: result.trickResult.winnerTeam,
        tie: result.trickResult.tie
      });
    }

    // Sempre manda o estado com a carta recém-jogada (e a vaza revelada)
    // ANTES de anunciar o fim da mão — senão a carta que decidiu o ponto
    // nunca chega a aparecer pra ninguém na mesa.
    r.broadcastState(io);

    if (result.maoOver) {
      const winnerTeam = result.maoWinnerTeam;
      const points = r.stake;
      const isGameOver = r.finishMao(winnerTeam, points);
      io.to(r.code).emit('mao_result', {
        winnerTeam, points, score: r.score, teamName: r.teamName(winnerTeam)
      });
      setTimeout(() => {
        if (isGameOver) {
          io.to(r.code).emit('game_over', { winnerTeam, score: r.score });
          rooms.delete(r.code);
        } else {
          r.startMao();
          r.players.forEach(p => io.to(p.id).emit('game_start', r.redactedStateFor(p.seat)));
          r.broadcastState(io);
        }
      }, 2200);
      return;
    }
  });

  socket.on('call_truco', ({ level }) => {
    const r = room();
    if (!r || !r.started || r.gameOver) return;
    const player = r.playerBySocket(socket.id);
    if (!player) return;
    const result = r.requestCall(player.seat, level);
    if (result.error) return socket.emit('error_message', result.error);
    io.to(r.code).emit('call_announced', {
      byTeam: player.team, byName: player.name, level, value: r.pendingCall.value
    });
    r.broadcastState(io);
  });

  socket.on('respond_truco', ({ action }) => {
    const r = room();
    if (!r || !r.started || r.gameOver) return;
    const player = r.playerBySocket(socket.id);
    if (!player) return;
    const result = r.respondCall(player.seat, action);
    if (result.error) return socket.emit('error_message', result.error);

    if (result.ran) {
      // manda o estado atual (pedido resolvido) antes de anunciar o fim da mão
      r.broadcastState(io);
      const isGameOver = r.finishMao(result.winnerTeam, result.points);
      io.to(r.code).emit('mao_result', {
        winnerTeam: result.winnerTeam, points: result.points, score: r.score,
        teamName: r.teamName(result.winnerTeam), ran: true
      });
      setTimeout(() => {
        if (isGameOver) {
          io.to(r.code).emit('game_over', { winnerTeam: result.winnerTeam, score: r.score });
          rooms.delete(r.code);
        } else {
          r.startMao();
          r.players.forEach(p => io.to(p.id).emit('game_start', r.redactedStateFor(p.seat)));
          r.broadcastState(io);
        }
      }, 2200);
      return;
    }

    io.to(r.code).emit('call_response', { action, byName: player.name });
    r.broadcastState(io);
  });

  socket.on('run_away', () => {
    const r = room();
    if (!r || !r.started || r.gameOver) return;
    const player = r.playerBySocket(socket.id);
    if (!player) return;
    if (r.pendingCall) return socket.emit('error_message', 'Há um pedido pendente — responda com Aceitar ou Fugir.');
    const result = r.runAway(player.seat);
    // manda o estado atualizado (pendingCall resolvido) antes do aviso de fim de mão
    r.broadcastState(io);
    const isGameOver = r.finishMao(result.winnerTeam, result.points);
    io.to(r.code).emit('mao_result', {
      winnerTeam: result.winnerTeam, points: result.points, score: r.score,
      teamName: r.teamName(result.winnerTeam), ran: true
    });
    setTimeout(() => {
      if (isGameOver) {
        io.to(r.code).emit('game_over', { winnerTeam: result.winnerTeam, score: r.score });
        rooms.delete(r.code);
      } else {
        r.startMao();
        r.players.forEach(p => io.to(p.id).emit('game_start', r.redactedStateFor(p.seat)));
        r.broadcastState(io);
      }
    }, 1800);
  });

  socket.on('chat_message', ({ text }) => {
    const r = room();
    if (!r) return;
    const player = r.playerBySocket(socket.id);
    if (!player || !text) return;
    const msg = { name: player.name, text: String(text).slice(0, 200), ts: Date.now() };
    io.to(r.code).emit('chat_message', msg);
  });

  socket.on('send_emoji', ({ emoji }) => {
    const r = room();
    if (!r) return;
    const player = r.playerBySocket(socket.id);
    if (!player) return;
    io.to(r.code).emit('emoji', { seat: player.seat, name: player.name, emoji });
  });

  socket.on('disconnect', () => {
    const r = room();
    if (!r) return;
    const player = r.playerBySocket(socket.id);
    if (!player) return;
    player.connected = false;
    io.to(r.code).emit('lobby_update', r.lobbyState());
    io.to(r.code).emit('chat_message', { name: 'Sistema', text: `${player.name} desconectou.`, ts: Date.now() });

    // limpa salas vazias/abandonadas
    const anyoneConnected = r.players.some(p => p.connected);
    if (!anyoneConnected) {
      setTimeout(() => {
        const stillThere = rooms.get(r.code);
        if (stillThere && !stillThere.players.some(p => p.connected)) {
          if (stillThere.characterPhaseTimer) clearTimeout(stillThere.characterPhaseTimer);
          rooms.delete(r.code);
        }
      }, 30000);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Truco Paulista rodando na porta ${PORT}`);
});
