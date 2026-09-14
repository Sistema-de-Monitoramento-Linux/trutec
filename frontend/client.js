// ============================================================================
// TRUCO PAULISTA ONLINE — client.js
// ============================================================================

// --------------------------------------------------------------------------
// Bloqueio de zoom: o site é pensado pra rodar numa resolução fixa (a mesa,
// as cartas, tudo depende disso). Zoom do usuário (pinch, duplo toque,
// Ctrl+scroll, Ctrl+/Ctrl-) quebra o layout, então bloqueamos tudo aqui.
// --------------------------------------------------------------------------

// Pinch-zoom no Safari/iOS (evento proprietário, ignora o viewport meta às vezes)
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('gesturechange', (e) => e.preventDefault());
document.addEventListener('gestureend', (e) => e.preventDefault());

// Pinch-zoom com dois dedos em geral (Android/Chrome)
document.addEventListener('touchmove', (e) => {
  if (e.touches.length > 1) e.preventDefault();
}, { passive: false });

// Duplo toque rápido pra dar zoom
let lastTouchEnd = 0;
document.addEventListener('touchend', (e) => {
  const now = Date.now();
  if (now - lastTouchEnd <= 300) e.preventDefault();
  lastTouchEnd = now;
}, { passive: false });

// Ctrl/Cmd + scroll do mouse (zoom do navegador no desktop)
document.addEventListener('wheel', (e) => {
  if (e.ctrlKey) e.preventDefault();
}, { passive: false });

// Atalhos de teclado de zoom: Ctrl/Cmd + '+', '-', '=' ou '0'
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && ['+', '-', '=', '0'].includes(e.key)) {
    e.preventDefault();
  }
});

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
let pendingPlayOrigin = null; // { cardId, rect } — de onde a minha carta partiu, pra animar até a mesa
let lastRenderedMao = null;
let lastRenderedTableLen = 0;

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

function getSavedCharacter() {
  try {
    return localStorage.getItem('trutec_meu_personagem') || null;
  } catch (e) {
    return null;
  }
}

// ------------------------------------------------------------------
// PAINEL: CRIAR PERSONAGEM (desenhar em cima do boneco)
// ------------------------------------------------------------------
(function initCharacterEditor() {
  const canvas = document.getElementById('character-canvas');
  if (!canvas) return; // painel não presente nesta tela/versão

  const ctx = canvas.getContext('2d');
  const colorPicker = document.getElementById('character-color-picker');
  const brushSizeInput = document.getElementById('character-brush-size');
  const btnPen = document.getElementById('btn-tool-pen');
  const btnEraser = document.getElementById('btn-tool-eraser');
  const btnUndo = document.getElementById('btn-character-undo');
  const btnClear = document.getElementById('btn-character-clear');
  const btnSave = document.getElementById('btn-character-save');
  const saveMsg = document.getElementById('character-save-msg');
  const characterBase = document.getElementById('character-base');

  let drawing = false;
  let currentColor = colorPicker.value;
  let currentTool = 'pen'; // 'pen' | 'eraser'
  let lastX = 0, lastY = 0;
  const undoStack = [];

  // ------------------------------------------------------------------
  // Aba "Pele": tom/cor do boneco via hue-rotate (o boneco é um SVG de
  // cor sólida, então rotacionar o matiz é suficiente pra trocar o tom).
  // ------------------------------------------------------------------
  const CHARACTER_BASE_COLOR = '#ff0042'; // cor original do svg do personagem
  const skinHueSlider = document.getElementById('character-skin-hue');
  const skinPresetsWrap = document.getElementById('skin-presets');
  const tabButtons = document.querySelectorAll('.editor-tab-btn');
  const tabPanels = document.querySelectorAll('.editor-tab-panel');
  let skinHue = 0;

  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      tabButtons.forEach(b => b.classList.remove('active'));
      tabPanels.forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      const panel = document.querySelector(`.editor-tab-panel[data-tab-panel="${btn.dataset.tab}"]`);
      if (panel) panel.classList.add('active');
    });
  });

  // Usa um canvas de 1x1 pra descobrir a cor real que o navegador produz
  // ao aplicar hue-rotate — assim as bolinhas de tom batem exatamente
  // com o resultado que vai aparecer no boneco.
  function hueRotatedColor(deg) {
    const c = document.createElement('canvas');
    c.width = 1; c.height = 1;
    const cx = c.getContext('2d');
    cx.filter = `hue-rotate(${deg}deg)`;
    cx.fillStyle = CHARACTER_BASE_COLOR;
    cx.fillRect(0, 0, 1, 1);
    const d = cx.getImageData(0, 0, 1, 1).data;
    return `rgb(${d[0]}, ${d[1]}, ${d[2]})`;
  }

  function setSkinHue(deg) {
    skinHue = deg;
    skinHueSlider.value = deg;
    characterBase.style.filter = deg ? `hue-rotate(${deg}deg)` : 'none';
    skinPresetsWrap.querySelectorAll('.skin-preset').forEach(b => {
      b.classList.toggle('active', Number(b.dataset.hue) === deg);
    });
  }

  const SKIN_PRESET_DEGS = [0, 25, 55, 100, 150, 190, 230, 270, 310];
  SKIN_PRESET_DEGS.forEach(deg => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'skin-preset' + (deg === 0 ? ' active' : '');
    b.dataset.hue = String(deg);
    b.style.background = hueRotatedColor(deg);
    b.title = deg === 0 ? 'Tom original' : `Tom ${deg}°`;
    b.addEventListener('click', () => setSkinHue(deg));
    skinPresetsWrap.appendChild(b);
  });

  skinHueSlider.addEventListener('input', () => setSkinHue(Number(skinHueSlider.value)));

  try {
    const savedHue = localStorage.getItem('trutec_personagem_hue');
    if (savedHue !== null) setSkinHue(Number(savedHue));
  } catch (e) { /* localStorage indisponível, ignora */ }

  function pushUndoState() {
    undoStack.push(canvas.toDataURL());
    if (undoStack.length > 20) undoStack.shift();
  }

  function pointerPos(e) {
    const rect = canvas.getBoundingClientRect();
    const cx = (e.touches ? e.touches[0].clientX : e.clientX);
    const cy = (e.touches ? e.touches[0].clientY : e.clientY);
    return {
      x: (cx - rect.left) * (canvas.width / rect.width),
      y: (cy - rect.top) * (canvas.height / rect.height)
    };
  }

  function startDraw(e) {
    e.preventDefault();
    drawing = true;
    pushUndoState();
    const p = pointerPos(e);
    lastX = p.x; lastY = p.y;
    drawDot(p.x, p.y);
  }

  function drawDot(x, y) {
    ctx.globalCompositeOperation = currentTool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.fillStyle = currentColor;
    ctx.beginPath();
    ctx.arc(x, y, Number(brushSizeInput.value) / 2, 0, Math.PI * 2);
    ctx.fill();
  }

  function moveDraw(e) {
    if (!drawing) return;
    e.preventDefault();
    const p = pointerPos(e);
    ctx.globalCompositeOperation = currentTool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = currentColor;
    ctx.lineWidth = Number(brushSizeInput.value);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(lastX, lastY);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    lastX = p.x; lastY = p.y;
  }

  function endDraw() { drawing = false; }

  canvas.addEventListener('mousedown', startDraw);
  canvas.addEventListener('mousemove', moveDraw);
  window.addEventListener('mouseup', endDraw);
  canvas.addEventListener('touchstart', startDraw, { passive: false });
  canvas.addEventListener('touchmove', moveDraw, { passive: false });
  canvas.addEventListener('touchend', endDraw);

  document.querySelectorAll('.color-swatch').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.color-swatch').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentColor = btn.dataset.color;
      colorPicker.value = currentColor;
      currentTool = 'pen';
      btnPen.classList.add('active');
      btnEraser.classList.remove('active');
    });
  });

  colorPicker.addEventListener('input', () => {
    currentColor = colorPicker.value;
    document.querySelectorAll('.color-swatch').forEach(b => b.classList.remove('active'));
    currentTool = 'pen';
    btnPen.classList.add('active');
    btnEraser.classList.remove('active');
  });

  btnPen.addEventListener('click', () => {
    currentTool = 'pen';
    btnPen.classList.add('active');
    btnEraser.classList.remove('active');
  });

  btnEraser.addEventListener('click', () => {
    currentTool = 'eraser';
    btnEraser.classList.add('active');
    btnPen.classList.remove('active');
  });

  btnUndo.addEventListener('click', () => {
    if (!undoStack.length) return;
    const last = undoStack.pop();
    const img = new Image();
    img.onload = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    };
    img.src = last;
  });

  btnClear.addEventListener('click', () => {
    pushUndoState();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  });

  btnSave.addEventListener('click', () => {
    // Junta o boneco base (com o tom escolhido na aba "Pele") + o desenho num único PNG.
    const merged = document.createElement('canvas');
    merged.width = canvas.width;
    merged.height = canvas.height;
    const mctx = merged.getContext('2d');
    const baseImg = document.getElementById('character-base');
    mctx.filter = skinHue ? `hue-rotate(${skinHue}deg)` : 'none';
    mctx.drawImage(baseImg, 0, 0, merged.width, merged.height);
    mctx.filter = 'none';
    mctx.drawImage(canvas, 0, 0);
    const dataUrl = merged.toDataURL('image/png');

    try {
      localStorage.setItem('trutec_meu_personagem', dataUrl);
      localStorage.setItem('trutec_personagem_hue', String(skinHue));
    } catch (e) {
      console.warn('Não foi possível salvar no localStorage:', e);
    }

    // Atualiza a prévia grande do personagem lá no lobby.
    const previewImg = document.getElementById('character-preview-img');
    if (previewImg) previewImg.src = dataUrl;

    // Se já estamos numa sala (esperando jogadores), avisa o backend
    // pra atualizar o avatar em tempo real pros outros jogadores também.
    if (myRoomCode) {
      socket.emit('update_character', { character: dataUrl });
    }

    saveMsg.textContent = 'Personagem salvo! ✅';
    setTimeout(() => { saveMsg.textContent = ''; }, 2500);
  });

  // Carrega um personagem salvo anteriormente, se existir, e mostra na prévia do lobby.
  try {
    const saved = localStorage.getItem('trutec_meu_personagem');
    if (saved) {
      saveMsg.textContent = 'Você já tem um personagem salvo.';
      const previewImg = document.getElementById('character-preview-img');
      if (previewImg) previewImg.src = saved;
    }
  } catch (e) { /* localStorage indisponível, ignora */ }
})();

// ------------------------------------------------------------------
// Abrir/fechar a tela de edição do personagem a partir do lobby
// ------------------------------------------------------------------
document.getElementById('btn-open-character-editor').addEventListener('click', () => {
  showScreen('screen-character-editor');
});

document.getElementById('btn-close-character-editor').addEventListener('click', () => {
  showScreen('screen-lobby');
});

function lobbyError(msg) {
  document.getElementById('lobby-error').textContent = msg || '';
}

document.getElementById('btn-quick').addEventListener('click', () => {
  myName = currentName();
  socket.emit('quick_join', { name: myName, mode: myMode, character: getSavedCharacter() }, (res) => {
    if (!res.ok) return lobbyError(res.error);
    myRoomCode = res.code;
    showScreen('screen-waiting');
  });
});

document.getElementById('btn-create').addEventListener('click', () => {
  myName = currentName();
  socket.emit('create_room', { name: myName, mode: myMode, isPublic: false, character: getSavedCharacter() }, (res) => {
    if (!res.ok) return lobbyError(res.error);
    myRoomCode = res.code;
    showScreen('screen-waiting');
  });
});

document.getElementById('btn-join').addEventListener('click', () => {
  myName = currentName();
  const code = document.getElementById('input-code').value.trim();
  if (!code) return lobbyError('Digite o código da sala.');
  socket.emit('join_room', { code, name: myName, character: getSavedCharacter() }, (res) => {
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
      const avatarSrc = p.character || 'assets/personagem.svg';
      row.innerHTML = `
        <div class="wp-avatar"><img src="${avatarSrc}" alt="" draggable="false" /></div>
        <div class="wp-info">
          <span class="wp-name">${escapeHtml(p.name)}${p.connected ? '' : ' (saiu)'}</span>
          <span class="wp-team">Time ${p.team + 1}</span>
        </div>
      `;
    } else {
      row.className += ' wp-row-empty';
      row.innerHTML = `
        <div class="wp-avatar wp-avatar-empty"><img src="assets/personagem.svg" alt="" draggable="false" /></div>
        <div class="wp-info">
          <span class="wp-name" style="opacity:.5">Aguardando…</span>
          <span class="wp-team">—</span>
        </div>
      `;
    }
    wrap.appendChild(row);
  }
});

// ------------------------------------------------------------------
// INÍCIO DE JOGO
// ------------------------------------------------------------------
let matchIntroPlayed = false;

function playGameIntro() {
  const overlay = document.getElementById('game-intro');
  if (!overlay) return;
  overlay.classList.remove('fade-out');
  overlay.classList.add('active');

  // dá tempo da bolinha crescer + a logo aparecer, segura um instante,
  // e então esconde tudo revelando a mesa (que já está pronta por baixo)
  setTimeout(() => {
    overlay.classList.add('fade-out');
    setTimeout(() => {
      overlay.classList.remove('active', 'fade-out');
    }, 550);
  }, 2000);
}

socket.on('game_start', (state) => {
  mySeat = state.players.find(p => p.hand !== undefined).seat;
  myTeam = state.players.find(p => p.seat === mySeat).team;
  selectedCardId = null;
  esconderAtivo = false;
  showScreen('screen-game');
  setupSeatLabels(state);
  renderState(state);
  setBanner('');
  if (!matchIntroPlayed) {
    matchIntroPlayed = true;
    playGameIntro();
  }
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
  // ficam sobrepostas (levemente deslocadas), e as recém-jogadas "voam"
  // da mão de quem jogou até a mesa, em vez de simplesmente aparecerem.
  const tableWrap = document.getElementById('table-cards');
  const newPlayStartIdx = (lastRenderedMao === state.maoNumber) ? lastRenderedTableLen : 0;
  lastRenderedMao = state.maoNumber;
  lastRenderedTableLen = state.table.length;

  tableWrap.innerHTML = '';
  const BASE_ROT = { top: -3, left: 4, right: -4, bottom: 2 };
  const stackCount = {};
  state.table.forEach((play, idx) => {
    const pos = seatOffsetLabel(play.seat, n);
    const sIdx = stackCount[pos] || 0;
    stackCount[pos] = sIdx + 1;
    const holder = document.createElement('div');
    holder.className = `played-card played-pos-${pos}`;
    const rot = (BASE_ROT[pos] || 0) + sIdx * 6;
    const dx = sIdx * 8;
    const dy = -sIdx * 8;
    const finalTransform = `rotate(${rot}deg) translate(${dx}px, ${dy}px)`;
    holder.style.transform = finalTransform;
    holder.style.zIndex = String(sIdx + 1);
    if (play.hidden) {
      const back = document.createElement('div');
      back.className = 'card facedown';
      holder.appendChild(back);
    } else {
      holder.appendChild(buildCardEl(play.card, state.manilhaRank));
    }
    tableWrap.appendChild(holder);

    if (idx >= newPlayStartIdx) {
      animatePlayedCard(holder, play, pos, finalTransform);
    }
  });

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
      el.addEventListener('click', () => onCardClick(card, isMyTurn, el));
      handWrap.appendChild(el);
    }
  }

  // botões de ação
  updateActionButtons(state);

  // pedido pendente
  updateCallOverlay(state);
}

// Anima a carta "voando" da mão de quem jogou até a posição final na mesa
// (técnica FLIP: parte da posição de origem e transiciona até o destino real).
function animatePlayedCard(holder, play, pos, finalTransform) {
  let originRect = null;

  if (play.seat === mySeat && pendingPlayOrigin && play.card && pendingPlayOrigin.cardId === play.card.id) {
    originRect = pendingPlayOrigin.rect;
    pendingPlayOrigin = null;
  } else if (pos === 'bottom') {
    const myHandEl = document.getElementById('my-hand');
    if (myHandEl) originRect = myHandEl.getBoundingClientRect();
  } else {
    const srcEl = document.getElementById(`hand-${pos}`);
    if (srcEl) originRect = srcEl.getBoundingClientRect();
  }

  if (!originRect) return;

  const destRect = holder.getBoundingClientRect();
  const ox = (originRect.left + originRect.width / 2) - (destRect.left + destRect.width / 2);
  const oy = (originRect.top + originRect.height / 2) - (destRect.top + destRect.height / 2);

  holder.style.transition = 'none';
  holder.style.opacity = '0.5';
  holder.style.transform = `translate(${ox}px, ${oy}px) scale(0.62) ${finalTransform}`;
  // força o navegador a aplicar o estado inicial antes de animar até o final
  void holder.offsetWidth;
  holder.style.transition = 'transform .32s cubic-bezier(.22,.75,.32,1), opacity .28s ease';
  holder.style.transform = finalTransform;
  holder.style.opacity = '1';
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

function onCardClick(card, isMyTurn, el) {
  if (!isMyTurn) return;
  // um clique já joga a carta
  selectedCardId = card.id;
  if (el) {
    pendingPlayOrigin = { cardId: card.id, rect: el.getBoundingClientRect() };
  }
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

  const btnTruco = document.getElementById('btn-truco');
  if (nextLevel) {
    btnTruco.textContent = nextLevel.toUpperCase();
    btnTruco.dataset.level = nextLevel;
    btnTruco.disabled = !canCall;
  } else {
    btnTruco.disabled = true;
  }

  document.getElementById('btn-correr').disabled = !isMyTurn || !!state.pendingCall || state.gameOver;
  document.getElementById('btn-esconder').disabled = !isMyTurn || !!state.pendingCall || state.gameOver;
}

document.getElementById('btn-truco').addEventListener('click', () => {
  const level = document.getElementById('btn-truco').dataset.level;
  if (!level) return;
  socket.emit('call_truco', { level });
});

document.getElementById('btn-correr').addEventListener('click', () => {
  socket.emit('run_away');
});

// ------------------------------------------------------------------
// Sair da sala
// ------------------------------------------------------------------
document.getElementById('btn-exit-room').addEventListener('click', () => {
  if (confirm('Tem certeza que deseja sair da sala?')) {
    location.reload();
  }
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
let bannerTimer = null;
function setBanner(text, holdMs = 2600) {
  const el = document.getElementById('banner');
  clearTimeout(bannerTimer);
  if (!text) {
    el.classList.remove('show');
    return;
  }
  el.textContent = text;
  el.classList.add('show');
  bannerTimer = setTimeout(() => {
    el.classList.remove('show');
  }, holdMs);
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
