// ============================================================================
// CONFIGURAÇÃO DO FRONTEND
// ============================================================================
// Troque a URL abaixo pela URL pública do seu backend no Render
// (ex: depois de criar o Web Service, o Render te dá algo como
//  https://truco-paulista-backend.onrender.com — copie e cole aqui).
//
// Dica: você pode testar contra o backend rodando localmente adicionando
// ?server=http://localhost:3000 no final da URL do site, sem precisar editar
// este arquivo nem fazer novo deploy.
// ============================================================================

const BACKEND_URL = 'https://SEU-BACKEND.onrender.com';

// Não mexa daqui pra baixo -----------------------------------------------
const _params = new URLSearchParams(window.location.search);
const RESOLVED_BACKEND_URL = _params.get('server') || BACKEND_URL;
