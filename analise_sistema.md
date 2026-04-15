# Análise do Sistema: Xandeflix

O **Xandeflix** é uma plataforma de streaming IPTV robusta e moderna, construída com foco em fornecer uma experiência visual premium semelhante à Netflix. O sistema é composto por um frontend React altamente otimizado e um backend Node.js (Express) que atua como proxy e gerenciador de conteúdo.

## 🏗️ Arquitetura do Sistema

O projeto utiliza uma abordagem de monólito moderno com separação clara de responsabilidades:

### 1. Camada de Frontend (React + Vite)
*   **Tech Stack**: React 19, TypeScript, Tailwind CSS 4, Framer Motion (para animações suaves).
*   **Estado**: Gerenciado via **Zustand**, garantindo um fluxo de dados reativo e leve.
*   **Design**: Baseado em princípios de "Glassmorphism" e estética Premium Dark.
    *   Cores personalizadas: `netflix-red` (#E50914), `bg-dark` (#050505).
    *   Tipografia: Fontes modernas (Inter e Outfit) via Google Fonts.
*   **Player de Vídeo**: Multi-protocolo usando `video.js`, `mpegts.js` (para streams HTTP-TS) e `mux.js`.

### 2. Camada de Backend (Express.js)
O servidor atua em três frentes principais:
*   **Gerenciador de Playlist**: Processamento inteligente de listas de reprodução remotas e normalização de metadados.
*   **Autenticação e Administração**: Controle de usuários e acesso à plataforma.

### 3. Serviços de Backend (`/server/services`)
*   **M3UParserService**: Transforma arquivos M3U brutos em categorias e itens estruturados.
*   **TMDBService**: Integração com a API do TMDB para enriquecimento automático de metadados de VOD.
*   **CacheManager**: Sistema de cache de 30 minutos para evitar requisições redundantes a provedores externos.
*   **AdminService**: Gerencia a persistência de usuários no arquivo `users.json`.

---

## 🔒 Segurança e Performance

*   **Whitelist de Domínios**: Apenas domínios de playlists autorizados podem ser acessados via API de diagnóstico.
*   **Segurança de Headers**: Implementação de CSP e outros headers de segurança via middleware.
*   **Otimização de Carregamento**:
    *   Uso de compressão Gzip/Brotli para dados de texto (JSON/M3U).
    *   Arquitetura **Fast Origin Transfer**: O vídeo é servido diretamente da origem, eliminando custos de transferência e latência no servidor.
    *   "Request Coalescing" no parser de playlist (múltiplas requisições simultâneas para a mesma URL são unificadas em uma única busca).

---

## 🛠️ Funcionalidades Principais

| Recurso | Descrição |
| :--- | :--- |
| **Painel Admin** | Interface completa para gerenciar usuários, bloquear acessos e atualizar links de playlists. |
| **Página Inicial Dinâmica** | Destaques automáticos (Hero Section) com gradientes cinematográficos. |
| **Classificação de Conteúdo** | Separação automática entre Filmes, Séries e Canais. |
| **Modo Cinema** | Foco total no player com redução de distrações visuais. |
| **Diagnóstico de Rede** | Ferramenta integrada para testar a conectividade com os servidores de stream. |

## 🚀 Próximas Implementações / Sugestões

1.  **Migração de DB**: Atualmente o sistema usa `users.json`. Para escalabilidade, uma migração para SQLite ou PostgreSQL seria recomendada.
2.  **EPG (Electronic Program Guide)**: Adição de guias de programação para canais de TV ao vivo.
3.  **Favoritos**: Permitir que usuários salvem conteúdos preferidos.

---
> [!NOTE]
> O sistema está configurado para rodar via `npm run dev`, que habilita o `tsx watch`.
