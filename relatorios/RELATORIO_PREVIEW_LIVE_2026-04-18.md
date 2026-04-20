# Relatorio Tecnico - LiveTV Preview (Xandeflix)

Data: 18/04/2026
Projeto: xandeflix-main
Escopo: fluxos de "Canais ao Vivo" e "Esportes" (preview embutido + fullscreen)

## 1. Objetivo da intervencao

Ajustar o comportamento da area de preview da tela de canais ao vivo para:

- iniciar canal automaticamente ao entrar na tela;
- incluir canais de diferentes grupos/categorias na rotacao aleatoria;
- manter clique em canal com comportamento correto (preview primeiro, fullscreen depois);
- estabilizar tentativa de reproducao em Android WebView (preview inline);
- preservar player nativo para fullscreen.

## 2. Conectividade e ambiente validados

Durante a sessao, foi confirmado repetidamente:

- dispositivo Android conectado via ADB (`RX2X301Q3KY`);
- `adb reverse` ativo para `tcp:5173` (e tambem `tcp:5174` quando necessario);
- app carregando via dev server (`http://localhost:5173`), com eventos de hot update no logcat.

Conclusao: a sincronizacao em tempo real entre codigo e tablet esteve funcional.

## 3. Mudancas implementadas

### 3.1. LiveTVGrid - pool global de canais para preview
Arquivo: `src/components/LiveTVGrid.tsx`

Implementado `globalPreviewPool` com deduplicacao de canais por `id::videoUrl`, reunindo itens de todos os grupos live recebidos pela tela.

Referencias:
- `globalPreviewPool`: linhas proximas de `166-192`
- log de contexto de grupos/pool: linhas proximas de `193-198`

### 3.2. Auto-preview ao entrar na tela
Arquivo: `src/components/LiveTVGrid.tsx`

Ao entrar na tela, seleciona canal aleatorio do pool global e seta preview com atraso curto para evitar race de render.

Referencias:
- efeito de auto-preview: linhas proximas de `199-246`

### 3.3. Fallback de falha de preview
Arquivo: `src/components/LiveTVGrid.tsx`

Adicionado `handlePreviewPlaybackFailed` para trocar de canal quando a URL atual falha.

Evolucao aplicada:
- passou a usar pool global (nao apenas categoria atual);
- passou a evitar repeticao imediata com conjunto `previewTriedKeysRef`;
- prioriza candidatos de grupo diferente quando possivel;
- possui limite de falhas consecutivas para interromper looping.

Referencias:
- callback de falha: linhas proximas de `254-318`

### 3.4. Clique em canal: preview primeiro, fullscreen no segundo clique
Arquivo: `src/components/LiveTVGrid.tsx`

Comportamento corrigido para remover promocao imediata para fullscreen no Android.

Estado final do fluxo:
- primeiro clique: seleciona canal na previa;
- segundo clique no mesmo canal (quando ja manual): abre fullscreen.

Referencia:
- `handleMediaClick`: linhas proximas de `420-441`

### 3.5. VideoPlayer - estrategia de URL e fallback de reproducao
Arquivo: `src/components/VideoPlayer.tsx`

Mudancas relevantes para preview inline:

1. Candidatos de URL live reorganizados:
- prioriza URL original e variacoes antes de forcar HLS em cenarios TS.

2. Deteccao de tipo HLS:
- criada funcao `isLikelyHlsUrl` para decidir se usa `hls.js` ou `video.src` direto.

3. Fluxo de inicializacao robusto:
- timeout de startup para tentativa de fonte;
- fallback sequencial para proxima URL candidata;
- notificacao para `onPreviewPlaybackFailed` quando esgota alternativas.

Referencias:
- candidatos de URL: linhas proximas de `91-155`
- `isLikelyHlsUrl`: linhas proximas de `157-169`
- engine de preview web/native inline: linhas proximas de `940-1188`

## 4. Validacao tecnica executada

- `npx eslint src/components/LiveTVGrid.tsx src/components/VideoPlayer.tsx`
  - sem erros bloqueantes (apenas warnings pre-existentes de limpeza/refactor).
- `npx tsc -p tsconfig.strict.json --noEmit`
  - sem erros.

## 5. Resultado funcional atual

### 5.1. O que melhorou

- infraestrutura de fallback e diagnostico ficou mais completa;
- regras de clique foram corrigidas para preview antes de fullscreen;
- rotacao entre grupos passou a existir no algoritmo de fallback.

### 5.2. O que ainda nao foi resolvido (principal)

- preview continua sem iniciar reproducao de forma confiavel;
- como o preview falha, o fallback entra em acao e aparenta "troca aleatoria" apos alguns segundos.

Interpretacao do sintoma reportado:
- a troca aleatoria observada e efeito do mecanismo de resiliencia (`handlePreviewPlaybackFailed`) reagindo a falhas de startup do stream.

## 6. Causa provavel do comportamento atual

Com base nos testes anteriores e no padrao dos endpoints, existe forte indicio de indisponibilidade/retorno invalido das URLs de stream para o contexto do preview (WebView/HTML5), mesmo quando o fluxo de selecao e fallback esta correto.

Em termos praticos:
- selecao de canal acontece;
- player tenta abrir;
- nao recebe condicao valida para `playing`;
- fallback troca para outro canal.

## 7. Proximos passos recomendados (prioridade)

1. Congelar fallback automatico apos 1a falha por entrada de tela, exibindo estado de erro na previa.
- evita experiencia de "troca infinita";
- facilita depuracao por canal.

2. Instrumentar log com codigo de erro nativo de `<video>` (`MediaError`) e URL final usada.
- hoje temos logs de timeout/fallback, mas precisamos do detalhe de erro do elemento de video.

3. Criar estrategia de "teste ativo" por categoria:
- filtrar canais testados por tentativas recentes;
- marcar canal como "invalido temporario" por janela curta para nao reciclar falhas.

4. (Se necessario) fallback de preview para abrir mini-player nativo dedicado quando o stream for TS puro.
- abordagem mais complexa, mas possivel caso WebView siga incompativel com determinados fornecedores.

## 8. Status para retomada

- conexao dev + adb pronta e funcional;
- ponto de entrada principal para continuacao:
  - `src/components/LiveTVGrid.tsx` (selecao/fallback);
  - `src/components/VideoPlayer.tsx` (bootstrap de reproducao preview).

