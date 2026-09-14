// ============================================================================
// TRUCO PAULISTA ONLINE — client.js
// ============================================================================

const socket = io(RESOLVED_BACKEND_URL, {
  transports: ['websocket', 'polling']
});

socket.on('connect_error', (err) => {
  console.error('Falha ao conectar no backend:', err.message);
  lobbyErrorSafe(
    `Não foi possível conectar ao servidor (${RESOLVED_BACKEND_URL}). ` +
    `Verifique se a URL em config.js está correta e se o backend está no ar.`
  );
});

function lobbyErrorSafe(msg) {
  const el = document.getElementById('lobby-error');
  if (el) el.textContent = msg;
}

const SUIT_SYMBOLS = { ouros: '♦', espadas: '♠', copas: '♥', paus: '♣' };
const SUIT_COLOR = { ouros: 'red', espadas: 'black', copas: 'red', paus: 'black' };

let myName = '';
let myMode = '1v1';
let myRoomCode = null;
let mySeat = null;
let myTeam = null;
let selectedCardId = null;
let esconderAtivo = false;
let latestState = null;

// ------------------------------------------------------------------
// Navegação de telas
// ------------------------------------------------------------------
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// ------------------------------------------------------------------
// TELA LOBBY
// ------------------------------------------------------------------
document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    myMode = btn.dataset.mode;
  });
});

function currentName() {
  const v = document.getElementById('input-name').value.trim();
  return v || `Jogador${Math.floor(Math.random() * 900 + 100)}`;
}

function lobbyError(msg) {
  document.getElementById('lobby-error').textContent = msg || '';
}

document.getElementById('btn-quick').addEventListener('click', () => {
  myName = currentName();
  socket.emit('quick_join', { name: myName, mode: myMode }, (res) => {
    if (!res.ok) return lobbyError(res.error);
    myRoomCode = res.code;
    showScreen('screen-waiting');
  });
});

document.getElementById('btn-create').addEventListener('click', () => {
  myName = currentName();
  socket.emit('create_room', { name: myName, mode: myMode, isPublic: false }, (res) => {
    if (!res.ok) return lobbyError(res.error);
    myRoomCode = res.code;
    showScreen('screen-waiting');
  });
});

document.getElementById('btn-join').addEventListener('click', () => {
  myName = currentName();
  const code = document.getElementById('input-code').value.trim();
  if (!code) return lobbyError('Digite o código da sala.');
  socket.emit('join_room', { code, name: myName }, (res) => {
    if (!res.ok) return lobbyError(res.error);
    myRoomCode = res.code;
    showScreen('screen-waiting');
  });
});

document.getElementById('btn-leave-waiting').addEventListener('click', () => {
  location.reload();
});

// ------------------------------------------------------------------
// SALA DE ESPERA
// ------------------------------------------------------------------
socket.on('lobby_update', (lobby) => {
  document.getElementById('waiting-code').textContent = lobby.code;
  const wrap = document.getElementById('waiting-players');
  wrap.innerHTML = '';
  for (let i = 0; i < lobby.maxPlayers; i++) {
    const p = lobby.players.find(pl => pl.seat === i);
    const row = document.createElement('div');
    row.className = 'wp-row';
    if (p) {
      row.innerHTML = `<span>${p.name}${p.connected ? '' : ' (saiu)'}</span><span>Time ${p.team + 1}</span>`;
    } else {
      row.innerHTML = `<span style="opacity:.5">Aguardando…</span><span>—</span>`;
    }
    wrap.appendChild(row);
  }
});

// ------------------------------------------------------------------
// INÍCIO DE JOGO
// ------------------------------------------------------------------
socket.on('game_start', (state) => {
  mySeat = state.players.find(p => p.hand !== undefined).seat;
  myTeam = state.players.find(p => p.seat === mySeat).team;
  selectedCardId = null;
  esconderAtivo = false;
  showScreen('screen-game');
  setupSeatLabels(state);
  renderState(state);
  setBanner('');
});

function setupSeatLabels(state) {
  const n = state.players.length;
  const labelA = myTeam === 0 ? 'Nós' : 'Eles';
  const labelB = myTeam === 0 ? 'Eles' : 'Nós';
  document.getElementById('label-team-a').textContent = labelA;
  document.getElementById('label-team-b').textContent = labelB;
}

// ------------------------------------------------------------------
// ATUALIZAÇÃO DE ESTADO
// ------------------------------------------------------------------
socket.on('state_update', (state) => {
  renderState(state);
});

function seatOffsetLabel(seat, n) {
  // posição relativa à minha cadeira: bottom=eu, top=oposto, left/right = parceiros/adversários
  const rel = (seat - mySeat + n) % n;
  if (n === 2) return rel === 0 ? 'bottom' : 'top';
  // n === 4
  if (rel === 0) return 'bottom';
  if (rel === 1) return 'left';
  if (rel === 2) return 'top';
  if (rel === 3) return 'right';
}

function renderState(state) {
  latestState = state;
  const n = state.players.length;

  // placar: score[0]/score[1] -> mapeia pro meu time
  const myScore = state.score[myTeam];
  const oppScore = state.score[myTeam === 0 ? 1 : 0];
  document.getElementById('score-a').textContent = myScore;
  document.getElementById('score-b').textContent = oppScore;
  document.getElementById('stake-label').textContent = state.stakeLabel;

  // vira
  renderMiniCard(document.getElementById('vira-card'), state.vira);

  // nomes e cadeiras
  ['top', 'left', 'right', 'bottom'].forEach(pos => {
    const nameEl = document.getElementById(`name-${pos}`);
    if (nameEl && pos !== 'bottom') nameEl.textContent = '—';
  });

  for (const p of state.players) {
    const pos = seatOffsetLabel(p.seat, n);
    if (pos === 'bottom') {
      document.getElementById('name-bottom').textContent = `${p.name} (você)`;
      document.getElementById('name-bottom').classList.toggle('active-turn', state.turnSeat === p.seat);
      continue;
    }
    const nameEl = document.getElementById(`name-${pos}`);
    const handEl = document.getElementById(`hand-${pos}`);
    if (nameEl) {
      let label = p.name;
      if (n === 4 && p.team === myTeam) label += ' (parceiro)';
      nameEl.textContent = label;
      nameEl.classList.toggle('active-turn', state.turnSeat === p.seat);
    }
    if (handEl) {
      const isActive = state.turnSeat === p.seat;
      // só recria os elementos quando a quantidade de cartas muda de fato —
      // se recriarmos sempre, o navegador nunca vê um estado "anterior"
      // pra animar a transição de deitada -> de pé.
      if (handEl.children.length !== p.cardsLeft) {
        handEl.innerHTML = '';
        for (let i = 0; i < p.cardsLeft; i++) {
          const back = document.createElement('div');
          back.className = 'card-back';
          handEl.appendChild(back);
        }
      }
      handEl.classList.toggle('active-turn', isActive);
    }
  }
  document.getElementById('seat-top').style.visibility = n >= 2 ? 'visible' : 'hidden';
  document.getElementById('seat-left').style.visibility = n === 4 ? 'visible' : 'hidden';
  document.getElementById('seat-right').style.visibility = n === 4 ? 'visible' : 'hidden';

  // mesa (cartas jogadas) — cartas de rodadas anteriores do mesmo jogador
  // ficam sobrepostas (levemente deslocadas), em vez de somem por trás da nova.
  const tableWrap = document.getElementById('table-cards');
  tableWrap.innerHTML = '';
  const BASE_ROT = { top: -3, left: 4, right: -4, bottom: 2 };
  const stackCount = {};
  for (const play of state.table) {
    const pos = seatOffsetLabel(play.seat, n);
    const idx = stackCount[pos] || 0;
    stackCount[pos] = idx + 1;
    const holder = document.createElement('div');
    holder.className = `played-card played-pos-${pos}`;
    const rot = (BASE_ROT[pos] || 0) + idx * 6;
    const dx = idx * 8;
    const dy = -idx * 8;
    holder.style.transform = `rotate(${rot}deg) translate(${dx}px, ${dy}px)`;
    holder.style.zIndex = String(idx + 1);
    if (play.hidden) {
      const back = document.createElement('div');
      back.className = 'card facedown';
      holder.appendChild(back);
    } else {
      holder.appendChild(buildCardEl(play.card, state.manilhaRank));
    }
    tableWrap.appendChild(holder);
  }

  // minha mão
  const me = state.players.find(p => p.seat === mySeat);
  const handWrap = document.getElementById('my-hand');
  handWrap.innerHTML = '';
  if (me && me.hand) {
    for (const card of me.hand) {
      const el = buildCardEl(card, state.manilhaRank);
      if (card.id === selectedCardId) el.classList.add('selected');
      const isMyTurn = state.turnSeat === mySeat && !state.pendingCall;
      if (!isMyTurn) el.classList.add('disabled');
      el.addEventListener('click', () => onCardClick(card, isMyTurn));
      handWrap.appendChild(el);
    }
  }

  // botões de ação
  updateActionButtons(state);

  // pedido pendente
  updateCallOverlay(state);
}

function renderMiniCard(el, card) {
  if (!card) { el.textContent = ''; return; }
  el.className = 'mini-card ' + (SUIT_COLOR[card.suit] || '');
  el.innerHTML = `${card.rank}<span style="font-size:.9em">${SUIT_SYMBOLS[card.suit]}</span>`;
}

function buildCardEl(card, manilhaRank) {
  const el = document.createElement('div');
  el.className = 'card ' + (SUIT_COLOR[card.suit] || '');
  if (card.rank === manilhaRank) el.classList.add('manilha');
  const symbol = SUIT_SYMBOLS[card.suit];
  el.innerHTML = `
    <div class="card-corner corner-tl"><span>${card.rank}</span>${symbol}</div>
    <div class="card-face">
      <div class="rank">${card.rank}</div>
      <div class="suit">${symbol}</div>
    </div>
    <div class="card-corner corner-br"><span>${card.rank}</span>${symbol}</div>
  `;
  el.dataset.cardId = card.id;
  return el;
}

function onCardClick(card, isMyTurn) {
  if (!isMyTurn) return;
  // um clique já joga a carta
  selectedCardId = card.id;
  playSelectedCard();
}

function playSelectedCard() {
  if (!selectedCardId) return;
  socket.emit('play_card', { cardId: selectedCardId, hidden: esconderAtivo });
  selectedCardId = null;
  esconderAtivo = false;
  document.getElementById('btn-esconder').classList.remove('esconder-active');
}

document.getElementById('btn-esconder').addEventListener('click', () => {
  esconderAtivo = !esconderAtivo;
  document.getElementById('btn-esconder').classList.toggle('esconder-active', esconderAtivo);
});

// ------------------------------------------------------------------
// Botões de truco / fugir
// ------------------------------------------------------------------
function updateActionButtons(state) {
  const isMyTurn = state.turnSeat === mySeat;
  const canCall = isMyTurn && !state.pendingCall && !state.gameOver;
  const nextLevelByStake = { 1: 'truco', 3: 'seis', 6: 'nove', 9: 'doze' };
  const nextLevel = nextLevelByStake[state.stake];
  const lastRaiserIsMyTeam = false; // servidor valida de qualquer forma

  ['truco', 'seis', 'nove', 'doze'].forEach(level => {
    const btn = document.getElementById(`btn-${level}`);
    btn.disabled = !(canCall && nextLevel === level);
  });

  document.getElementById('btn-correr').disabled = !isMyTurn || !!state.pendingCall || state.gameOver;
  document.getElementById('btn-esconder').disabled = !isMyTurn || !!state.pendingCall || state.gameOver;
}

['truco', 'seis', 'nove', 'doze'].forEach(level => {
  document.getElementById(`btn-${level}`).addEventListener('click', () => {
    socket.emit('call_truco', { level });
  });
});

document.getElementById('btn-correr').addEventListener('click', () => {
  socket.emit('run_away');
});

// ------------------------------------------------------------------
// Overlay de pedido pendente (truco/aceitar/fugir/aumentar)
// ------------------------------------------------------------------
function updateCallOverlay(state) {
  const overlay = document.getElementById('call-overlay');
  if (!state.pendingCall) { overlay.classList.add('hidden'); return; }

  const myRespond = myTeam === state.pendingCall.respondingTeam;
  if (!myRespond) {
    overlay.classList.add('hidden');
    setBanner(`Aguardando resposta do adversário… (${state.pendingCall.level.toUpperCase()})`);
    return;
  }
  overlay.classList.remove('hidden');
  document.getElementById('call-text').textContent =
    `Pediram ${state.pendingCall.level.toUpperCase()}! Valendo ${state.pendingCall.value} pontos. O que você faz?`;

  const nextValue = { 3: 6, 6: 9, 9: 12 }[state.pendingCall.value];
  document.getElementById('btn-aumentar-resp').style.display = nextValue ? 'block' : 'none';
}

document.getElementById('btn-aceitar').addEventListener('click', () => {
  socket.emit('respond_truco', { action: 'aceitar' });
});
document.getElementById('btn-fugir').addEventListener('click', () => {
  socket.emit('respond_truco', { action: 'fugir' });
});
document.getElementById('btn-aumentar-resp').addEventListener('click', () => {
  socket.emit('respond_truco', { action: 'aumentar' });
});

// ------------------------------------------------------------------
// Eventos de jogo (banners / resultados)
// ------------------------------------------------------------------
function setBanner(text) {
  const el = document.getElementById('banner');
  el.textContent = text || '';
  el.classList.toggle('show', !!text);
}

socket.on('call_announced', ({ byTeam, byName, level, value }) => {
  const mine = byTeam === myTeam;
  setBanner(`${byName} pediu ${level.toUpperCase()}! (valendo ${value})`);
});

socket.on('call_response', ({ action, byName }) => {
  const label = action === 'aceitar' ? 'aceitou' : action === 'fugir' ? 'fugiu' : 'aumentou';
  setBanner(`${byName} ${label}!`);
});

socket.on('trick_result', ({ winnerSeat, winnerTeam, tie }) => {
  if (tie) { setBanner('Rodada empatada!'); return; }
  const mine = winnerTeam === myTeam;
  setBanner(mine ? 'Vocês ganharam a rodada!' : 'Eles ganharam a rodada.');
});

socket.on('mao_result', ({ winnerTeam, points, teamName, ran }) => {
  const mine = winnerTeam === myTeam;
  setBanner(`${mine ? 'Vocês' : 'Eles'} ${ran ? 'ganharam por fuga' : 'venceram a mão'}: +${points} pontos!`);
});

socket.on('game_over', ({ winnerTeam, score }) => {
  const mine = winnerTeam === myTeam;
  document.getElementById('gameover-title').textContent = mine ? '🏆 Vocês venceram!' : 'Vocês perderam';
  document.getElementById('gameover-sub').textContent = `Placar final: ${score[0]} x ${score[1]}`;
  setTimeout(() => showScreen('screen-gameover'), 400);
});

document.getElementById('btn-play-again').addEventListener('click', () => location.reload());

socket.on('error_message', (msg) => {
  setBanner(msg);
  setTimeout(() => setBanner(''), 2500);
});

// ------------------------------------------------------------------
// Chat + emojis
// ------------------------------------------------------------------
document.getElementById('btn-toggle-chat').addEventListener('click', () => {
  document.getElementById('chat-panel').classList.toggle('hidden');
});

document.getElementById('btn-send-chat').addEventListener('click', sendChat);
document.getElementById('chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendChat();
});
function sendChat() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;
  socket.emit('chat_message', { text });
  input.value = '';
}

socket.on('chat_message', ({ name, text }) => {
  const wrap = document.getElementById('chat-messages');
  const row = document.createElement('div');
  row.innerHTML = `<b>${name}:</b> ${escapeHtml(text)}`;
  wrap.appendChild(row);
  wrap.scrollTop = wrap.scrollHeight;
});

document.querySelectorAll('.emoji-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    socket.emit('send_emoji', { emoji: btn.textContent });
  });
});

socket.on('emoji', ({ seat, emoji }) => {
  const layer = document.getElementById('emoji-layer');
  const el = document.createElement('div');
  el.className = 'floating-emoji';
  el.textContent = emoji;
  const n = latestState ? latestState.players.length : 2;
  const pos = seat !== null && mySeat !== null ? seatOffsetLabel(seat, n) : 'bottom';
  const coords = {
    bottom: { left: '50%', top: '75%' },
    top: { left: '50%', top: '15%' },
    left: { left: '15%', top: '45%' },
    right: { left: '80%', top: '45%' }
  }[pos] || { left: '50%', top: '50%' };
  el.style.left = coords.left;
  el.style.top = coords.top;
  layer.appendChild(el);
  setTimeout(() => el.remove(), 1700);
});

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
