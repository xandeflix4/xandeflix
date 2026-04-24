import { useEffect, useCallback, useRef, useSyncExternalStore } from 'react';
import { useStore } from '../store/useStore';

interface NavCallbacks {
  onFocus?: () => void;
  onEnter?: () => void;
  onBack?: () => void;
  disableAutoScroll?: boolean;
}

interface NavNode {
  id: string;
  ref: HTMLElement | null;
  section: string;
  onFocus?: () => void;
  onEnter?: () => void;
  onBack?: () => void;
  disableAutoScroll?: boolean;
}

interface RegisterNodeObject extends NavCallbacks {
  id: string;
  type?: string;
  section?: string;
  ref?: HTMLElement | null;
}

const navNodes: Map<string, NavNode> = new Map();
let focusedNodeId: string | null = null;
const focusListeners = new Set<() => void>();
let globalLastKeyTime = 0; // Module-level debounce shared across ALL hook instances
const TV_KEY_DEBOUNCE_MS = 105;

const DPAD_KEY_MAP: Record<number, string> = {
  4: 'Back',
  19: 'ArrowUp',
  20: 'ArrowDown',
  21: 'ArrowLeft',
  22: 'ArrowRight',
  23: 'Enter',
  27: 'Escape',
  66: 'Enter',
};

const normalizeTvKey = (e: KeyboardEvent) => {
  const keyCode = (e as KeyboardEvent & { keyCode?: number; which?: number }).keyCode
    ?? (e as KeyboardEvent & { which?: number }).which
    ?? 0;

  if (e.key === 'Right') return 'ArrowRight';
  if (e.key === 'Left') return 'ArrowLeft';
  if (e.key === 'Up') return 'ArrowUp';
  if (e.key === 'Down') return 'ArrowDown';
  if (e.key === 'Select' || e.key === 'OK') return 'Enter';

  return DPAD_KEY_MAP[keyCode] || e.key;
};

const isNaturallyFocusable = (element: HTMLElement) => {
  const tag = element.tagName.toLowerCase();
  if (tag === 'button' || tag === 'input' || tag === 'select' || tag === 'textarea') {
    return true;
  }
  if (tag === 'a' && element.hasAttribute('href')) {
    return true;
  }
  return element.hasAttribute('contenteditable');
};

const ensureFocusable = (element: HTMLElement | null) => {
  if (!element) return;
  if (!isNaturallyFocusable(element) && !element.hasAttribute('tabindex')) {
    element.tabIndex = 0;
  }
};

const applyNavMetadata = (element: HTMLElement | null, id: string, section: string) => {
  if (!element) return;
  ensureFocusable(element);
  element.dataset.navId = id;
  element.dataset.navSection = section;
  if (!element.id) {
    element.id = id;
  }
};

const findElementByNavId = (id: string): HTMLElement | null => {
  if (typeof document === 'undefined') {
    return null;
  }

  const escapedId = id.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const byDataAttr = document.querySelector(`[data-nav-id="${escapedId}"]`) as HTMLElement | null;
  if (byDataAttr) {
    return byDataAttr;
  }

  return document.getElementById(id);
};

const getNavIdFromElement = (element: HTMLElement | null): string | null => {
  if (!element) {
    return null;
  }

  const navTarget = element.closest?.('[data-nav-id]') as HTMLElement | null;
  const navId = navTarget?.dataset?.navId;
  if (navId) {
    return navId;
  }

  const idTarget = element.closest?.('[id]') as HTMLElement | null;
  const elementId = idTarget?.id;
  if (elementId && navNodes.has(elementId)) {
    return elementId;
  }

  return null;
};

const resolveNodeRef = (node: NavNode): HTMLElement | null => {
  if (node.ref && node.ref.isConnected) {
    return node.ref;
  }

  if (typeof document === 'undefined') {
    return null;
  }

  const queried = findElementByNavId(node.id);
  if (queried) {
    ensureFocusable(queried);
    node.ref = queried;
    navNodes.set(node.id, node);
  }

  return queried;
};

const getActiveNavId = (): string | null => {
  if (typeof document === 'undefined') {
    return null;
  }

  const activeElement = document.activeElement as HTMLElement | null;
  return getNavIdFromElement(activeElement);
};

const subscribeFocusedId = (listener: () => void) => {
  focusListeners.add(listener);
  return () => focusListeners.delete(listener);
};

const getFocusedIdSnapshot = () => focusedNodeId;
const getFocusedIdServerSnapshot = () => null;

const emitFocusedId = (id: string | null) => {
  focusedNodeId = id;
  focusListeners.forEach((listener) => listener());
};

const getFirstNavigableNode = (): NavNode | null => {
  const allNodes = Array.from(navNodes.values());
  const validNodes = allNodes.filter((node) => {
    const ref = resolveNodeRef(node);
    return ref && !ref.closest('[aria-hidden="true"]');
  });

  // Prefer main content over sidebar menus and modals
  const preferredNode = validNodes.find(
    (node) => !node.id.startsWith('menu-') && !node.id.startsWith('exit-') && !node.id.startsWith('details-')
  );

  return preferredNode || validNodes[0] || null;
};

const isElementMostlyInViewport = (element: HTMLElement, margin = 24): boolean => {
  if (typeof window === 'undefined') return true;
  const rect = element.getBoundingClientRect();
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
  return (
    rect.top >= -margin
    && rect.left >= -margin
    && rect.bottom <= viewportHeight + margin
    && rect.right <= viewportWidth + margin
  );
};

const focusNode = (
  node: NavNode,
  preventEventDefault?: () => void,
  smoothScroll?: boolean,
): boolean => {
  const ref = resolveNodeRef(node);
  if (!ref) return false;

  ensureFocusable(ref);
  if (preventEventDefault) preventEventDefault();

  ref.focus({ preventScroll: true });
  if (!node.disableAutoScroll && !isElementMostlyInViewport(ref)) {
    ref.scrollIntoView({
      behavior: smoothScroll ? 'smooth' : 'auto',
      block: 'center',
      inline: 'center',
    });
  }

  node.onFocus?.();
  return true;
};

export const useTvNavigation = (options?: { onBack?: () => void; isActive?: boolean; subscribeFocused?: boolean }) => {
  const onBack = options?.onBack;
  const isActive = options?.isActive !== false;
  const subscribeFocused = options?.subscribeFocused === true;
  const isTvMode = useStore((state) => state.isTvMode);
  const focusedIdRef = useRef<string | null>(null);
  const shouldHandleTvKeys = isActive && isTvMode;

  const setFocusedId = useCallback(
    (id: string | null) => {
      if (id == null || id === '') {
        if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
        focusedIdRef.current = null;
        emitFocusedId(null);
        return;
      }

      const node = navNodes.get(id);
      if (node && focusNode(node, undefined, !isTvMode)) {
        focusedIdRef.current = id;
        emitFocusedId(id);
        return;
      }

      if (typeof document === 'undefined') {
        return;
      }

      const element = findElementByNavId(id);
      if (!element) return;

      ensureFocusable(element);
      element.focus({ preventScroll: true });
      if (!node?.disableAutoScroll) {
        element.scrollIntoView({
          behavior: isTvMode ? 'auto' : 'smooth',
          block: 'center',
          inline: 'center',
        });
      }
      focusedIdRef.current = id;
      emitFocusedId(id);
    },
    [isTvMode],
  );

  const registerNode = useCallback(
    (
      idOrObject: string | RegisterNodeObject,
      ref?: HTMLElement | null,
      section: string = 'default',
      callbacks?: NavCallbacks,
    ) => {
      let id = '';
      let nodeRef: HTMLElement | null | undefined = ref;
      let nodeSection = section;
      let nodeCallbacks: NavCallbacks | undefined = callbacks;

      if (typeof idOrObject === 'string') {
        id = idOrObject;
      } else {
        id = idOrObject.id;
        nodeSection = idOrObject.section || idOrObject.type || 'default';
        nodeRef = idOrObject.ref;
        nodeCallbacks = {
          onFocus: idOrObject.onFocus,
          onEnter: idOrObject.onEnter,
          onBack: idOrObject.onBack,
          disableAutoScroll: idOrObject.disableAutoScroll,
        };
      }

      if (!id) {
        return () => {};
      }

      // Cleanup call pattern: registerNode(id, null)
      const wantsCleanup = nodeRef == null && !nodeCallbacks?.onFocus && !nodeCallbacks?.onEnter && !nodeCallbacks?.onBack;
      if (wantsCleanup) {
        const existingNode = navNodes.get(id);
        if (existingNode?.ref) {
          if (existingNode.ref.dataset.navId === id) {
            delete existingNode.ref.dataset.navId;
          }
          if (existingNode.ref.dataset.navSection) {
            delete existingNode.ref.dataset.navSection;
          }
        }
        navNodes.delete(id);
        return () => navNodes.delete(id);
      }

      const existingNode = navNodes.get(id);
      const normalizedRef = nodeRef ?? existingNode?.ref ?? null;
      applyNavMetadata(normalizedRef, id, nodeSection);

      navNodes.set(id, {
        id,
        ref: normalizedRef,
        section: nodeSection,
        ...nodeCallbacks,
      });

      return () => {
        navNodes.delete(id);
      };
    },
    [],
  );

  const calculateDistance = (rect1: DOMRect, rect2: DOMRect, direction: string) => {
    const center1 = { x: rect1.left + rect1.width / 2, y: rect1.top + rect1.height / 2 };
    const center2 = { x: rect2.left + rect2.width / 2, y: rect2.top + rect2.height / 2 };

    const dx = Math.abs(center1.x - center2.x);
    const dy = Math.abs(center1.y - center2.y);

    if (direction === 'ArrowLeft' || direction === 'ArrowRight') {
      return dx + (dy * 2);
    }

    return dy + (dx * 2);
  };

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const now = Date.now();
      if (now - globalLastKeyTime < TV_KEY_DEBOUNCE_MS) return;
      globalLastKeyTime = now;

      const key = normalizeTvKey(e);
      const currentFocusedId = getActiveNavId() ?? focusedIdRef.current;
      const currentNode = currentFocusedId ? navNodes.get(currentFocusedId) : null;

      if (key === 'Escape' || key === 'Back') {
        if (currentNode?.onBack) {
          e.preventDefault();
          currentNode.onBack();
          return;
        }

        if (onBack) {
          e.preventDefault();
          onBack();
        }
        return;
      }

      if (!currentFocusedId || !currentNode) {
        const firstNode = getFirstNavigableNode();
        if (firstNode && focusNode(firstNode, () => e.preventDefault(), !isTvMode)) {
          focusedIdRef.current = firstNode.id;
          emitFocusedId(firstNode.id);
        }
        return;
      }

      const currentRef = resolveNodeRef(currentNode);
      if (!currentRef) {
        const firstNode = getFirstNavigableNode();
        if (firstNode && focusNode(firstNode, () => e.preventDefault(), !isTvMode)) {
          focusedIdRef.current = firstNode.id;
          emitFocusedId(firstNode.id);
        }
        return;
      }

      const currentRect = currentRef.getBoundingClientRect();

      // Fast path for carousel body items.
      const itemMatch = currentFocusedId.match(/^(.*?)(item-(\d+)-(\d+))$/);
      if (itemMatch && (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown')) {
        const idPrefix = itemMatch[1] || '';
        const row = Number(itemMatch[3]);
        const column = Number(itemMatch[4]);
        const candidateIds: string[] = [];

        if (key === 'ArrowLeft') {
          if (column > 0) {
            candidateIds.push(`${idPrefix}item-${row}-${column - 1}`);
          } else {
            const activeMenuId = `menu-${useStore.getState().activeFilter || 'home'}`;
            candidateIds.push(activeMenuId, 'menu-home', 'menu-search', 'menu-live', 'menu-movie', 'menu-series');
          }
        } else if (key === 'ArrowRight') {
          candidateIds.push(`${idPrefix}item-${row}-${column + 1}`, `${idPrefix}see-all-${row}`, `see-all-${row}`);
        } else if (key === 'ArrowUp') {
          if (row > 0) {
            candidateIds.push(`${idPrefix}item-${row - 1}-${column}`, `item-${row - 1}-${column}`);
          } else {
            // Row 0 -> VAI PARA OS BOTÕES DO HERO
            candidateIds.push('hero-play', 'hero-info', 'menu-home');
          }
        } else if (key === 'ArrowDown') {
          candidateIds.push(`${idPrefix}item-${row + 1}-${column}`, `${idPrefix}see-all-${row + 1}`, `see-all-${row + 1}`);
        }

        for (const candidateId of candidateIds) {
          const candidate = navNodes.get(candidateId);
          if (!candidate) continue;
          const didFocus = focusNode(
            candidate,
            () => e.preventDefault(),
            !isTvMode,
          );
          if (didFocus) {
            focusedIdRef.current = candidate.id;
            emitFocusedId(candidate.id);
            return;
          }
        }
      }

      // Fast path for menu vertical navigation.
      if (currentNode.section === 'menu' && (key === 'ArrowUp' || key === 'ArrowDown')) {
        const menuNodes = Array.from(navNodes.values())
          .filter((node) => node.section === 'menu' && resolveNodeRef(node))
          .sort((a, b) => {
            const aRect = resolveNodeRef(a)?.getBoundingClientRect();
            const bRect = resolveNodeRef(b)?.getBoundingClientRect();
            if (!aRect || !bRect) return 0;
            if (aRect.top === bRect.top) return aRect.left - bRect.left;
            return aRect.top - bRect.top;
          });

        const currentIndex = menuNodes.findIndex((node) => node.id === currentNode.id);
        if (currentIndex >= 0) {
          const nextIndex =
            key === 'ArrowUp'
              ? Math.max(0, currentIndex - 1)
              : Math.min(menuNodes.length - 1, currentIndex + 1);
          const target = menuNodes[nextIndex];
          if (target && target.id !== currentNode.id) {
            const didFocus = focusNode(target, () => e.preventDefault(), !isTvMode);
            if (didFocus) {
              focusedIdRef.current = target.id;
              emitFocusedId(target.id);
              return;
            }
          }
        }
      }

      // Fast path for menu right navigation (entering Hero or main content).
      if (currentNode.section === 'menu' && key === 'ArrowRight') {
        const candidateIds = ['hero-play', 'hero-info', 'item-0-0', 'item-1-0'];
        // Also try to enter the first tv-group if on LiveTV screen
        const tvGroupNodes = Array.from(navNodes.keys()).filter(k => k.startsWith('tv-group-'));
        if (tvGroupNodes.length > 0) {
          candidateIds.unshift(tvGroupNodes[0]);
        }
        for (const candidateId of candidateIds) {
          const candidate = navNodes.get(candidateId);
          if (!candidate) continue;

          if (focusNode(candidate, () => e.preventDefault(), !isTvMode)) {
            focusedIdRef.current = candidate.id;
            emitFocusedId(candidate.id);
            return;
          }
        }
      }

      // ============================================================
      // Fast path for LiveTV groups (tv-group-*) — index-based nav
      // ============================================================
      if (currentFocusedId.startsWith('tv-group-')) {
        const groupIds = Array.from(navNodes.keys())
          .filter(k => k.startsWith('tv-group-'))
          .sort((a, b) => {
            const aEl = findElementByNavId(a);
            const bEl = findElementByNavId(b);
            if (!aEl || !bEl) return 0;
            const aTop = aEl.getBoundingClientRect().top;
            const bTop = bEl.getBoundingClientRect().top;
            // For items at same approximate Y, fall back to DOM order
            if (Math.abs(aTop - bTop) < 5) return 0;
            return aTop - bTop;
          });
        const currentIdx = groupIds.indexOf(currentFocusedId);

        if (key === 'ArrowDown' || key === 'ArrowUp') {
          const nextIdx = key === 'ArrowDown'
            ? Math.min(groupIds.length - 1, currentIdx + 1)
            : Math.max(0, currentIdx - 1);
          const targetId = groupIds[nextIdx];
          if (targetId && targetId !== currentFocusedId) {
            const target = navNodes.get(targetId);
            if (target && focusNode(target, () => e.preventDefault(), !isTvMode)) {
              focusedIdRef.current = target.id;
              emitFocusedId(target.id);
              return;
            }
          }
          e.preventDefault();
          return; // block scroll even if at boundary
        }

        if (key === 'Enter') {
          e.preventDefault();
          e.stopImmediatePropagation();
          if (currentNode.onEnter) {
            currentNode.onEnter();
          }
          return;
        }

        if (key === 'ArrowRight') {
          // Move into the channels column — pick first channel
          const channelIds = Array.from(navNodes.keys()).filter(k => k.startsWith('tv-channel-'));
          if (channelIds.length > 0) {
            const target = navNodes.get(channelIds[0]);
            if (target && focusNode(target, () => e.preventDefault(), !isTvMode)) {
              focusedIdRef.current = target.id;
              emitFocusedId(target.id);
              return;
            }
          }
        }

        if (key === 'ArrowLeft') {
          // Move back to sidebar menu
          const activeMenuId = `menu-${useStore.getState().activeFilter || 'home'}`;
          const menuCandidates = [activeMenuId, 'menu-home', 'menu-live', 'menu-search'];
          for (const mid of menuCandidates) {
            const target = navNodes.get(mid);
            if (target && focusNode(target, () => e.preventDefault(), !isTvMode)) {
              focusedIdRef.current = target.id;
              emitFocusedId(target.id);
              return;
            }
          }
        }
      }

      // ============================================================
      // Fast path for LiveTV channels (tv-channel-*) — index-based nav
      // ============================================================
      if (currentFocusedId.startsWith('tv-channel-')) {
        const channelIds = Array.from(navNodes.keys())
          .filter(k => k.startsWith('tv-channel-'));
        // channelIds are in insertion order which matches the list order
        const currentIdx = channelIds.indexOf(currentFocusedId);

        if (key === 'ArrowDown' || key === 'ArrowUp') {
          const nextIdx = key === 'ArrowDown'
            ? Math.min(channelIds.length - 1, currentIdx + 1)
            : Math.max(0, currentIdx - 1);
          const targetId = channelIds[nextIdx];
          if (targetId && targetId !== currentFocusedId) {
            const target = navNodes.get(targetId);
            if (target && focusNode(target, () => e.preventDefault(), !isTvMode)) {
              focusedIdRef.current = target.id;
              emitFocusedId(target.id);
              return;
            }
          }
          e.preventDefault();
          return; // block scroll even if at boundary
        }

        if (key === 'Enter') {
          e.preventDefault();
          e.stopImmediatePropagation();
          if (currentNode.onEnter) {
            currentNode.onEnter();
          }
          return;
        }

        if (key === 'ArrowLeft') {
          // Move back to the groups column — pick the currently active group
          const groupIds = Array.from(navNodes.keys()).filter(k => k.startsWith('tv-group-'));
          if (groupIds.length > 0) {
            // Try to find the currently selected group first
            for (const gid of groupIds) {
              const el = findElementByNavId(gid);
              if (el && el.classList.contains('active')) {
                const target = navNodes.get(gid);
                if (target && focusNode(target, () => e.preventDefault(), !isTvMode)) {
                  focusedIdRef.current = target.id;
                  emitFocusedId(target.id);
                  return;
                }
              }
            }
            // Fallback: first group
            const target = navNodes.get(groupIds[0]);
            if (target && focusNode(target, () => e.preventDefault(), !isTvMode)) {
              focusedIdRef.current = target.id;
              emitFocusedId(target.id);
              return;
            }
          }
        }

        if (key === 'ArrowRight') {
          // Move to the preview player
          const prevTarget = navNodes.get('tv-preview-player');
          if (prevTarget && focusNode(prevTarget, () => e.preventDefault(), !isTvMode)) {
            focusedIdRef.current = prevTarget.id;
            emitFocusedId(prevTarget.id);
            return;
          }
        }
      }

      // ============================================================
      // Fast path for preview player (tv-preview-player)
      // ============================================================
      if (currentFocusedId === 'tv-preview-player') {
        if (key === 'ArrowLeft') {
          // Move back to channels
          const channelIds = Array.from(navNodes.keys()).filter(k => k.startsWith('tv-channel-'));
          if (channelIds.length > 0) {
            const target = navNodes.get(channelIds[0]);
            if (target && focusNode(target, () => e.preventDefault(), !isTvMode)) {
              focusedIdRef.current = target.id;
              emitFocusedId(target.id);
              return;
            }
          }
        }
        if (key === 'Enter') {
          if (currentNode.onEnter) {
            e.preventDefault();
            currentNode.onEnter();
            return;
          }
        }
      }

      // Fast path for Hero button navigation (D-Pad navigation from hero-play / hero-info).
      if (currentNode.section === 'hero' && (key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight')) {
        const candidateIds: string[] = [];

        if (key === 'ArrowDown') {
          // Hero → first media row
          candidateIds.push('item-0-0', 'item-0-1', 'item-0-2', 'item-1-0');
        } else if (key === 'ArrowLeft') {
          if (currentFocusedId === 'hero-info') {
            // info → play
            candidateIds.push('hero-play');
          } else {
            // play → sidebar menu
            const activeMenuId = `menu-${useStore.getState().activeFilter || 'home'}`;
            candidateIds.push(activeMenuId, 'menu-home', 'menu-search', 'menu-live', 'menu-movie', 'menu-series');
          }
        } else if (key === 'ArrowRight') {
          if (currentFocusedId === 'hero-play') {
            // play → info
            candidateIds.push('hero-info');
          }
        }

        for (const candidateId of candidateIds) {
          const candidate = navNodes.get(candidateId);
          if (!candidate) continue;

          if (focusNode(candidate, () => e.preventDefault(), !isTvMode)) {
            focusedIdRef.current = candidate.id;
            emitFocusedId(candidate.id);
            return;
          }
        }
      }

      let bestNode: NavNode | null = null;
      let minDistance = Infinity;

      const currentSection = currentNode.section;
      const isCurrentModalSection = String(currentSection || '').startsWith('modal');
      for (const node of navNodes.values()) {
        if (node.id === currentFocusedId) continue;

        // OTIMIZAÇÃO: Restringir busca a nós da mesma seção ou seções adjacentes conhecidas (fast path fallback)
        // Isso evita chamar getBoundingClientRect() em centenas de nós fora da viewport.
        const isMenuTransition = (key === 'ArrowLeft' && node.section === 'menu') || (currentSection === 'menu' && key === 'ArrowRight');
        const isHeroTransition = (key === 'ArrowUp' && node.section === 'hero') || (currentSection === 'hero' && key === 'ArrowDown');
        const isModalTransition =
          isCurrentModalSection
          && String(node.section || '').startsWith('modal');
        
        if (node.section !== currentSection && !isMenuTransition && !isHeroTransition && !isModalTransition) {
          continue;
        }

        const nodeRef = resolveNodeRef(node);
        if (!nodeRef) continue;

        const nodeRect = nodeRef.getBoundingClientRect();
        if (nodeRect.width === 0 && nodeRect.height === 0) continue;

        let isEligible = false;
        if (key === 'ArrowRight') isEligible = nodeRect.left >= currentRect.right - 5;
        if (key === 'ArrowLeft') isEligible = nodeRect.right <= currentRect.left + 5;
        if (key === 'ArrowDown') isEligible = nodeRect.top >= currentRect.bottom - 5;
        if (key === 'ArrowUp') isEligible = nodeRect.bottom <= currentRect.top + 5;

        if (!isEligible) continue;

        const distance = calculateDistance(currentRect, nodeRect, key);
        if (distance < minDistance) {
          minDistance = distance;
          bestNode = node;
        }
      }

      if (bestNode) {
        const didFocus = focusNode(bestNode, () => e.preventDefault(), !isTvMode);
        if (didFocus) {
          focusedIdRef.current = bestNode.id;
          emitFocusedId(bestNode.id);
          return;
        }
      }

      if (key === 'Enter') {
        if (currentNode.onEnter) {
          e.preventDefault();
          currentNode.onEnter();
          return;
        }

        currentRef.click();
      }
    },
    [isTvMode, onBack],
  );

  useEffect(() => {
    if (!isActive || typeof window === 'undefined') {
      return;
    }

    const handleFocusIn = (event: FocusEvent) => {
      const target = event.target as HTMLElement | null;
      focusedIdRef.current = getNavIdFromElement(target);
      emitFocusedId(focusedIdRef.current);
    };

    window.addEventListener('focusin', handleFocusIn);
    return () => window.removeEventListener('focusin', handleFocusIn);
  }, [isActive]);

  useEffect(() => {
    if (shouldHandleTvKeys) {
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }
  }, [handleKeyDown, shouldHandleTvKeys]);

  const focusedId = useSyncExternalStore(
    subscribeFocused ? subscribeFocusedId : () => () => {},
    subscribeFocused ? getFocusedIdSnapshot : () => null,
    subscribeFocused ? getFocusedIdServerSnapshot : () => null,
  );

  return { registerNode, focusedId, setFocusedId };
};
