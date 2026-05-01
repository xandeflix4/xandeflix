import React, { useState } from 'react';
import { motion } from 'motion/react';
import { Search, Home, Film, Tv, Settings, User, Radio, LogOut, Heart, Trophy, Baby } from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { useTvNavigation } from '../hooks/useTvNavigation';
import { useResponsiveLayout } from '../hooks/useResponsiveLayout';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface MenuItem {
  id: string;
  label: string;
  icon: React.ElementType;
}

const MENU_ITEMS: MenuItem[] = [
  { id: 'search', label: 'Busca', icon: Search },
  { id: 'home', label: 'Início', icon: Home },
  { id: 'mylist', label: 'Minha Lista', icon: Heart },
  { id: 'live', label: 'Canais ao Vivo', icon: Radio },
  { id: 'sports', label: 'Esportes', icon: Trophy },
  { id: 'movie', label: 'Filmes', icon: Film },
  { id: 'series', label: 'Séries', icon: Tv },
  { id: 'kids', label: 'Infantil', icon: Baby },
  { id: 'settings', label: 'Ajustes', icon: Settings },
];

interface SideMenuProps {
  onSelect?: (id: string) => void;
  activeId?: string;
  onLogout?: () => void;
  onExpandedChange?: (expanded: boolean) => void;
}

export const SideMenu: React.FC<SideMenuProps> = ({ onSelect, activeId = 'home', onLogout, onExpandedChange }) => {
  const { registerNode } = useTvNavigation({ isActive: false, subscribeFocused: false });
  const layout = useResponsiveLayout();
  const [isExpanded, setIsExpanded] = useState(false);
  const [focusedItem, setFocusedItem] = useState<string | null>(null);
  const [menuHasFocus, setMenuHasFocus] = useState(false);
  const [isTouchDevice, setIsTouchDevice] = useState(false);
  const isTvDevice = true;

  React.useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }

    const coarsePointerQuery = window.matchMedia('(pointer: coarse)');
    const noHoverQuery = window.matchMedia('(hover: none)');

    const updateTouchCapability = () => {
      setIsTouchDevice(coarsePointerQuery.matches || noHoverQuery.matches);
    };

    updateTouchCapability();

    const addListener = (query: MediaQueryList, handler: () => void) => {
      if (typeof query.addEventListener === 'function') {
        query.addEventListener('change', handler);
        return () => query.removeEventListener('change', handler);
      }
      query.addListener(handler);
      return () => query.removeListener(handler);
    };

    const removeCoarseListener = addListener(coarsePointerQuery, updateTouchCapability);
    const removeHoverListener = addListener(noHoverQuery, updateTouchCapability);

    return () => {
      removeCoarseListener();
      removeHoverListener();
    };
  }, []);

  React.useEffect(() => {
    // Updates the parent ref instantly — no re-render triggered.
    onExpandedChange?.(isExpanded);
  }, [isExpanded, onExpandedChange]);

  // Register menu items for global TV navigation
  React.useEffect(() => {
    const unregisterList: (() => void)[] = [];
    
    // Helper to register an item
    const reg = (id: string, onEnter: () => void) => {
      unregisterList.push(registerNode({
        id: `menu-${id}`,
        type: 'menu',
        onEnter,
        onFocus: () => {
          setIsExpanded(true);
          setFocusedItem(id);
        }
      }));
    };

    reg('profile', () => handlePress('profile'));
    MENU_ITEMS.forEach(item => reg(item.id, () => handlePress(item.id)));

    reg('logout', () => {
      collapseMenu();
      onLogout?.();
    });

    return () => unregisterList.forEach(u => u());
  }, [onLogout, registerNode]);

  // Colapsar menu automaticamente quando o filtro ativo muda e garante
  // que o menu não fica preso expandido ao carregar/recarregar a home.
  React.useEffect(() => {
    collapseMenu({ blurActiveElement: false });
  }, [activeId]);

  const collapseMenu = (options: { blurActiveElement?: boolean } = {}) => {
    setIsExpanded(false);
    setFocusedItem(null);
    setMenuHasFocus(false);

    if (options.blurActiveElement !== false && typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  };

  const handleFocus = (id: string) => {
    setIsExpanded(true);
    setFocusedItem(id);
  };

  const handlePress = (id: string) => {
    if (isTouchDevice && !isExpanded) {
      setIsExpanded(true);
      setFocusedItem(id);
      return;
    }

    collapseMenu({ blurActiveElement: false });

    if (onSelect) {
      onSelect(id);
    }
  };

  const handleBlur = () => {
    // We delay the collapse slightly to see if focus moves to another menu item
    setTimeout(() => {
      const activeElement = document.activeElement;
      if (!activeElement?.closest('.side-menu-panel')) {
        setIsExpanded(false);
        setFocusedItem(null);
        setMenuHasFocus(false);
      }
    }, layout.isTvProfile ? 12 : 50);
  };

  const showBackdrop = isTvDevice && menuHasFocus;
  const collapsedWidth = layout.sideRailCollapsedWidth || 80;
  const expandedWidth = layout.sideRailExpandedWidth || 280;
  const iconSize = layout.menuIconSize || 28;
  const boostedIconSize = Math.round(iconSize * (layout.isTvProfile ? 1.35 : 1.3));
  const labelFontSize = layout.menuLabelSize || 18;
  const panelHorizontalPadding = layout.isTvProfile ? 10 : 16;
  const collapsedHorizontalPadding = layout.isTvProfile ? 6 : panelHorizontalPadding;
  // PERF: Use fixed padding (collapsed) — the expanded state clips labels via overflow:hidden
  const panelContentPaddingX = collapsedHorizontalPadding;
  const panelVerticalPadding = layout.isTvProfile ? 24 : 32;
  const logoBottomMargin = layout.isTvProfile ? 18 : 24;
  const itemPadding = layout.isTvProfile ? 11 : 12;
  const iconColumnWidth = Math.max(28, collapsedWidth - (collapsedHorizontalPadding * 2) - (itemPadding * 2));
  const profileAvatarSize = Math.max(30, Math.min(iconColumnWidth, layout.isTvProfile ? 38 : 44));
  const profileIconSize = Math.round(boostedIconSize * 1.05);
  const isMenuActivated = menuHasFocus || isExpanded;

  // PERF: Label style computed once — labels are ALWAYS in the DOM, hidden by opacity
  const labelStyle: React.CSSProperties = {
    marginLeft: layout.isTvProfile ? 12 : 16,
    fontSize: labelFontSize,
    textAlign: 'left' as const,
    whiteSpace: 'nowrap' as const,
    pointerEvents: isExpanded ? 'auto' : 'none',
    opacity: isExpanded ? 1 : 0,
    transition: 'opacity 150ms ease-in-out',
  };

  return (
    <>
      <div
        className={cn(
          'pointer-events-none fixed inset-0 z-[240] bg-black/80',
          showBackdrop ? 'opacity-100' : 'opacity-0',
        )}
        style={{
          transition: 'opacity 120ms ease-out',
          willChange: showBackdrop ? 'opacity' : 'auto',
        }}
      />

      <div
        className={cn(
          'side-menu-panel fixed left-0 top-0 bottom-0 z-[260] border-none flex flex-col shadow-2xl',
          layout.isTvProfile ? 'bg-[#0a0a0a]' : 'bg-black/60 backdrop-blur-xl'
        )}
        style={{
          width: isExpanded ? expandedWidth : collapsedWidth,
          transition: layout.isTvProfile
            ? 'width 180ms cubic-bezier(0.22, 1, 0.36, 1)'
            : 'width 200ms ease-out, background-color 200ms ease-out',
          paddingTop: panelVerticalPadding,
          paddingBottom: Math.max(16, panelVerticalPadding - 8),
          borderRightWidth: 0,
          borderRightColor: 'transparent',
          willChange: 'width',
          transform: 'translate3d(0, 0, 0)',
          contain: 'layout style',
          overflow: 'hidden',
        }}
        onMouseEnter={() => setIsExpanded(true)}
        onMouseLeave={() => setIsExpanded(false)}
        onClick={() => {
          if (isTouchDevice && !isExpanded) {
            setIsExpanded(true);
          }
        }}
        onFocusCapture={() => setMenuHasFocus(true)}
        onBlurCapture={handleBlur}
      >
        {/* Logo Section */}
        <div
          className="h-10 flex items-center shrink-0 relative"
          style={{
            paddingLeft: panelContentPaddingX + 8,
            paddingRight: panelContentPaddingX + 8,
            marginBottom: logoBottomMargin,
            justifyContent: 'flex-start',
            width: expandedWidth,
          }}
        >
          <span 
            className="text-red-600 font-display font-black text-2xl tracking-tighter italic whitespace-nowrap absolute"
            style={{ 
              opacity: isExpanded ? 0 : 1, 
              transition: 'opacity 150ms ease-in-out',
              left: panelContentPaddingX + 8 + (iconColumnWidth / 2) - 10 // Center 'X' in icon column
            }}
          >
            X
          </span>
          <span 
            className="text-red-600 font-display font-black text-2xl tracking-tighter italic whitespace-nowrap"
            style={{ 
              opacity: isExpanded ? 1 : 0, 
              transition: 'opacity 150ms ease-in-out',
              marginLeft: layout.isTvProfile ? 4 : 8 
            }}
          >
            XANDEFLIX
          </span>
        </div>

        {/* User Profile Section — label always in DOM */}
        <div
          className="mb-4 shrink-0"
          style={{ paddingLeft: panelContentPaddingX, paddingRight: panelContentPaddingX }}
        >
          <div
            role="button"
            tabIndex={0}
            onFocus={() => handleFocus('profile')}
            onBlur={handleBlur}
            onClick={() => handlePress('profile')}
            data-nav-id="menu-profile"
            className="w-full flex flex-row items-center rounded-xl outline-none border-none bg-transparent"
            style={{
              padding: layout.isTvProfile ? 8 : 10,
              backgroundColor: 'transparent',
              WebkitTapHighlightColor: 'transparent',
              justifyContent: 'flex-start',
            }}
          >
            <div
              className="flex flex-row items-center"
              style={{ width: expandedWidth, justifyContent: 'flex-start' }}
            >
              <div
                className="bg-gradient-to-br from-blue-600 to-indigo-800 rounded-lg flex items-center justify-center shadow-lg shrink-0"
                style={{
                  width: profileAvatarSize,
                  height: profileAvatarSize,
                }}
              >
                <User color="white" size={profileIconSize} />
              </div>
              {/* PERF: Label always in DOM — hidden by panel overflow:hidden */}
              <div
                className="inline-block font-display font-bold text-white tracking-tight whitespace-nowrap"
                style={labelStyle}
              >
                Timbo
              </div>
            </div>
          </div>
        </div>

        {/* Navigation Items — labels always in DOM */}
        <div
          className="flex-1 space-y-1 overflow-y-auto scrollbar-hide"
          style={{
            paddingLeft: panelContentPaddingX,
            paddingRight: panelContentPaddingX,
            paddingTop: 8,
            paddingBottom: 8,
          }}
        >
          {MENU_ITEMS.map((item) => {
            const Icon = item.icon;
            const isFocused = focusedItem === item.id;
            const isActive = activeId === item.id;
            const isHighlighted = isFocused || (isMenuActivated && isActive);

            return (
              <div
                key={item.id}
                role="button"
                tabIndex={0}
                data-nav-id={`menu-${item.id}`}
                onFocus={() => handleFocus(item.id)}
                onBlur={handleBlur}
                onClick={() => handlePress(item.id)}
                className={cn(
                  "w-full flex items-center rounded-xl cursor-pointer group outline-none border-none bg-transparent",
                  layout.isTvProfile
                    ? (isFocused ? "opacity-100" : "opacity-70")
                    : cn("transition-all duration-150", isFocused ? "scale-105" : "opacity-70 scale-100")
                )}
                style={{
                  padding: itemPadding,
                  backgroundColor: 'transparent',
                  WebkitTapHighlightColor: 'transparent',
                  justifyContent: 'flex-start',
                }}
              >
                <div
                  className="flex flex-row items-center"
                  style={{ width: expandedWidth, justifyContent: 'flex-start' }}
                >
                  <div
                    className={cn(
                      "flex items-center justify-center shrink-0",
                      !layout.isTvProfile && "transition-transform duration-300 group-hover:scale-110"
                    )}
                    style={{ width: iconColumnWidth }}
                  >
                    <Icon 
                      size={boostedIconSize} 
                      color={isHighlighted ? "#E50914" : "rgba(255,255,255,0.6)"} 
                      strokeWidth={isHighlighted ? 2.5 : 1.5}
                    />
                  </div>
                  {/* PERF: Label always rendered — clipped by overflow:hidden */}
                  <div
                    className={cn(
                      "inline-block font-display tracking-tight whitespace-nowrap",
                      isHighlighted ? "text-white font-bold" : "text-gray-400"
                    )}
                    style={labelStyle}
                  >
                    {item.label}
                  </div>
                </div>
              </div>
            );
          })}


        </div>

        {/* Bottom Info — labels always in DOM */}
        <div
          className="border-none space-y-2 shrink-0"
          style={{
            paddingLeft: panelContentPaddingX,
            paddingRight: panelContentPaddingX,
            paddingTop: 12,
            paddingBottom: 12,
          }}
        >
          <div
            role="button"
            tabIndex={0}
            onFocus={() => handleFocus('logout')}
            onBlur={handleBlur}
            data-nav-id="menu-logout"
            onClick={() => {
              collapseMenu();
              onLogout?.();
            }}
            className={cn(
              "w-full flex items-center rounded-xl cursor-pointer group outline-none border-none bg-transparent",
              layout.isTvProfile
                ? (focusedItem === 'logout' ? "opacity-100" : "opacity-70")
                : cn("transition-all duration-150", focusedItem === 'logout' ? "scale-105" : "opacity-70")
            )}
            style={{
              padding: itemPadding,
              backgroundColor: 'transparent',
              WebkitTapHighlightColor: 'transparent',
              justifyContent: 'flex-start',
            }}
          >
            <div
              className="flex flex-row items-center"
              style={{ width: expandedWidth, justifyContent: 'flex-start' }}
            >
              <div
                className={cn(
                  "flex items-center justify-center shrink-0",
                  !layout.isTvProfile && "transition-transform duration-300 group-hover:scale-110"
                )}
                style={{ width: iconColumnWidth }}
              >
                <LogOut 
                  size={boostedIconSize} 
                  color={focusedItem === 'logout' ? "#E50914" : "rgba(255,255,255,0.6)"} 
                />
              </div>
              {/* PERF: Label always rendered */}
              <div
                className={cn(
                  "inline-block font-display tracking-tight whitespace-nowrap",
                  focusedItem === 'logout' ? "text-red-500 font-bold" : "text-gray-400"
                )}
                style={labelStyle}
              >
                Sair
              </div>
            </div>
          </div>

          {/* Version label — fades out when collapsed */}
          <div 
            className="px-4"
            style={{
              opacity: isExpanded ? 1 : 0,
              transition: 'opacity 150ms ease-in-out'
            }}
          >
            <span className="text-[10px] text-gray-500 uppercase tracking-widest font-display font-black whitespace-nowrap">
              Xandeflix Premium v1.2
            </span>
          </div>
        </div>
      </div>
    </>
  );
};
