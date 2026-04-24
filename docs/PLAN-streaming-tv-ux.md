# Plano de Ação: Estabilização de Streaming e UX Android TV

Este documento detalha as etapas lógicas e arquiteturais para resolver os 4 bugs críticos identificados no player e na navegação da Xandeflix.

## 🎯 Objetivos
1. Eliminar quedas silenciosas com retentativas automáticas e feedback visual.
2. Otimizar o gerenciamento de buffer para hardware limitado (Android TV).
3. Garantir a destruição atômica de instâncias do player para evitar crashes.
4. Corrigir a hierarquia de foco e gatilhos de reprodução no controle remoto.

---

## 🛠️ Fase 1: Resiliência do Player (Bugs 1 & 2)

### 1.1 Sistema de Retry com Backoff
*   **Ação:** Implementar um estado `retryCount` no `VideoPlayer.tsx`.
*   **Lógica:** Ao detectar um erro fatal (`HLS_FATAL`, `MPEGTS_FATAL` ou `PREVIEW_TIMEOUT`) após esgotar todos os candidatos a URL, disparar um timer de 5 segundos para nova tentativa automática (limite de 3 vezes).
*   **Feedback:** Mostrar um overlay de "Sinal Instável - Reconectando em Xs..." em vez de apenas fechar o player.

### 1.2 Otimização de Buffer
*   **Ação:** Ajustar as configurações de `hls.js` e `mpegts.js` para perfis de TV.
*   **Valores Propostos:**
    *   Reduzir `maxBufferSize` em 40% para evitar `OutOfMemory` no WebView da TV.
    *   Aumentar `manifestLoadingMaxRetry` e `fragLoadingMaxRetry`.
    *   Desativar `lowLatencyMode` em favor de um buffer de segurança maior (evita micro-travamentos).

---

## 🏗️ Fase 2: Ciclo de Vida e Estabilidade (Bug 3)

### 2.1 Destruição Atômica (Teardown)
*   **Ação:** Refatorar `teardownCurrentSource` para garantir que o `video.src` seja limpo de forma síncrona ANTES de criar a próxima instância.
*   **Proteção:** Adicionar um `ref` de `isTransitioning` que bloqueie novas inicializações por 300ms durante a troca de canal no preview, dando tempo para o Garbage Collector do WebView liberar os buffers de mídia anteriores.

### 2.2 Blindagem de Workers
*   **Ação:** Garantir que `mpegts.js` (que utiliza Workers) chame `player.destroy()` de forma determinística no `useEffect` cleanup, evitando vazamento de memória que causa o colapso do sistema após várias trocas.

---

## 📺 Fase 3: UX do Controle Remoto (Bug 4)

### 3.1 Correção de Foco na Coluna de Grupos
*   **Problema:** A navegação falha ao tentar mover para a direita se a lista de canais ainda não foi montada no DOM.
*   **Solução:** 
    1.  No `useTvNavigation.ts`, modificar o `ArrowRight` da seção `tv-group-*` para, caso não encontre canais, tentar novamente após um `requestAnimationFrame`.
    2.  Garantir que a coluna de grupos tenha `focusable={true}` e `tabIndex={0}` em todos os estados de renderização.

### 3.2 Separação Estrita Focus vs Select
*   **Ação:** 
    1.  Remover qualquer gatilho de `handleMediaClick` ou `setPreviewMedia` de dentro de `onFocus` ou `useEffect` que monitore o índice de foco.
    2.  Certificar que `isTvMode` está sendo detectado via `useStore` e que o componente `TouchableHighlight` no `LiveTVGrid.tsx` ignore eventos de `hover/mouseEnter` se o perfil for TV.
    3.  A reprodução (Zapping) só deve ocorrer no `onEnter` (mapeado para o botão OK/Select).

---

## ✅ Checklist de Verificação (Pós-Implementação)
- [ ] Troca rápida entre 10 canais seguidos (velocidade < 1s por troca) sem crash.
- [ ] Simulação de queda de rede (Offline) -> Player deve mostrar overlay de erro e tentar reconectar.
- [ ] Navegação Lateral (Esquerda/Direita) entre Grupos e Canais funcionando sem "perda" de foco.
- [ ] Seleção de canal só carrega a mídia ao apertar o botão central (OK), não ao apenas navegar com as setas.

---
**Nota:** Este plano prioriza a estabilidade sobre a performance de carregamento inicial, garantindo que o player seja "tanque" no ambiente restrito de Android TV.
