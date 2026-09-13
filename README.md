# 🂡 Truco Paulista Online

Truco Paulista multiplayer em tempo real. O projeto é dividido em duas partes,
hospedadas separadamente:

- **`backend/`** — Node.js + Express + Socket.io (lógica do jogo, salas, estado).
  Vai para o **Render** (ou Railway/Fly.io — qualquer host que rode um processo
  Node persistente).
- **`frontend/`** — HTML/CSS/JS puro (interface, mesa, lobby). Vai para a **Vercel**.

> Por que dividido? A Vercel roda em funções serverless: ótimas para sites e APIs
> stateless, mas não mantêm conexões WebSocket persistentes nem estado em memória
> entre chamadas — duas coisas que o Socket.io e o motor do truco precisam. Por
> isso o servidor de tempo real fica num host que roda um processo contínuo
> (Render), e a Vercel cuida só da interface.

## Rodando localmente (sem hospedar nada)

```bash
cd backend
npm install
npm start
```

Abra `frontend/index.html` direto no navegador, ou sirva a pasta com qualquer
servidor estático (ex: extensão "Live Server" do VS Code). Como o `config.js`
aponta por padrão pra um backend de produção que ainda não existe, teste local
adicionando `?server=http://localhost:3000` no final da URL, por exemplo:

```
http://127.0.0.1:5500/index.html?server=http://localhost:3000
```

(O backend também serve a pasta `frontend/` sozinho em `http://localhost:3000`,
então rodar só `npm start` dentro de `backend/` e abrir essa URL já funciona
pra testes rápidos sem precisar de dois servidores.)

## Deploy — passo a passo

### 1. Suba o projeto no GitHub

```bash
git init
git add .
git commit -m "Truco Paulista Online"
git branch -M main
git remote add origin https://github.com/SEU_USUARIO/truco-paulista-online.git
git push -u origin main
```

### 2. Backend no Render

1. Acesse [render.com](https://render.com) → **New +** → **Web Service**.
2. Conecte o repositório do GitHub.
3. O Render lê o `render.yaml` da raiz automaticamente (ele já aponta pra
   subpasta `backend/`). Confirme:
   - **Root Directory:** `backend`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Plan:** Free
4. Clique em **Create Web Service** e aguarde o build.
5. Copie a URL gerada (ex: `https://truco-paulista-backend.onrender.com`) —
   você vai precisar dela no próximo passo.

### 3. Frontend na Vercel

1. Edite `frontend/config.js` e troque:
   ```js
   const BACKEND_URL = 'https://SEU-BACKEND.onrender.com';
   ```
   pela URL real do seu backend do Render (passo anterior). Faça commit e push
   dessa mudança.
2. Acesse [vercel.com](https://vercel.com) → **Add New...** → **Project**.
3. Importe o mesmo repositório do GitHub.
4. Em **Root Directory**, selecione `frontend` (muito importante — é essa pasta
   que deve ser publicada, não a raiz do repo).
5. Framework preset: **Other** (é HTML/CSS/JS puro, sem build).
6. Clique em **Deploy**. Em ~30s você recebe uma URL tipo
   `https://truco-paulista-online.vercel.app`.

### 4. Fechando o ciclo: libere o CORS no backend

Por padrão o backend aceita qualquer origem (bom pra testar rápido), mas o
ideal é restringir à URL da Vercel:

1. No Render, vá em **Environment** do seu Web Service.
2. Adicione a variável:
   ```
   ALLOWED_ORIGINS = https://truco-paulista-online.vercel.app
   ```
   (pode listar mais de uma, separadas por vírgula, ex: incluir também
   `http://localhost:5500` pra continuar testando local.)
3. Salve — o Render reinicia o serviço sozinho.

Pronto: abra a URL da Vercel e jogue. 🎉

> ⚠️ No plano gratuito do Render, o backend "dorme" após alguns minutos sem uso
> e demora ~30s pra acordar no primeiro acesso do dia. É normal — só aguardar.

## Estrutura do projeto

```
truco-paulista/
├── render.yaml           # Blueprint de deploy do backend no Render
├── README.md
├── backend/
│   ├── server.js          # Express + Socket.io + lógica do jogo
│   ├── package.json
│   └── .gitignore
└── frontend/
    ├── index.html          # Telas: lobby, sala de espera, mesa, fim de jogo
    ├── style.css            # Mesa de feltro verde, responsivo
    ├── client.js             # Cliente Socket.io + renderização
    ├── config.js              # URL do backend (edite antes do deploy)
    └── vercel.json             # Config de hospedagem estática na Vercel
```

## Regras implementadas

- Salas 1v1 e 2v2 (dupla), com sala privada (código) ou pública (matchmaking automático).
- Baralho de 40 cartas, vira sorteada automaticamente definindo a manilha
  (força das manilhas: ouros < espadas < copas < paus, regra clássica do Truco Paulista).
- Pontuação por mão: 1 (normal), 3 (truco), 6 (seis), 9 (nove), 12 (doze).
- Botões: **Truco, Seis, Nove, Doze** (aumento progressivo), **Aceitar**, **Fugir**
  (recusar o aumento — o time que pediu ganha os pontos da aposta anterior),
  **Aumentar** (dentro do próprio pedido pendente, contra-aumenta na hora),
  e **Esconder Carta** (joga a carta virada para baixo — só é revelada aos outros
  jogadores no fim da rodada, útil pra blefar).
- Empate de vazas segue a regra tradicional: 1ª vaza empatada → decide a 2ª;
  se tudo empatar, quem abriu a mão leva.
- Chat de texto + emojis flutuantes na mesa.
- Reconexão de sala tolera desconexões temporárias (a sala fecha sozinha depois
  de 30s se todo mundo sair).

## Observações e possíveis evoluções

- A regra de "mão de 11" não está implementada — pode ser adicionada em
  `Room.startMao()` no `backend/server.js`.
- "Esconder Carta" é uma mecânica de blefe simplificada (varia por região/grupo,
  não é regra oficial universal) — só atrasa a revelação visual da carta pros
  adversários até o fim da rodada.
- Estado das partidas fica em memória (sem banco de dados) — reiniciar o backend
  no Render encerra as partidas em andamento. Ótimo pra jogar casualmente, mas
  não recomendado "as is" para produção séria com muitos usuários simultâneos.
