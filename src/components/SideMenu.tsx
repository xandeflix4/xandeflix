import React, { useState } from 'react';
import { Text } from 'react-native';
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
  const { registerNode } = useTvNavigation({ isActive: false, subscribeFocused: false }); // Do not subscribe focus state to avoid rerenders
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
  // que o menu nÃ£o fica preso expandido ao carregar/recarregar a home.
  React.useEffect(() => {
    collapseMenu();
  }, [activeId]);

  const collapseMenu = () => {
    setIsExpanded(false);
    setFocusedItem(null);
    setMenuHasFocus(false);

    if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
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

    collapseMenu();

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
    }, 50);
  };

  const showBackdrop = isTvDevice && menuHasFocus;
  const collapsedWidth = layout.sideRailCollapsedWidth || 80;
  const expandedWidth = layout.sideRailExpandedWidth || 280;
  const iconSize = layout.menuIconSize || 28;
  const labelFontSize = layout.menuLabelSize || 18;
  const panelHorizontalPadding = layout.isTvProfile ? 12 : 16;
  const panelVerticalPadding = layout.isTvProfile ? 24 : 32;
  const logoBottomMargin = layout.isTvProfile ? 18 : 24;
  const itemPadding = layout.isTvProfile ? 11 : 12;
  const isMenuActivated = menuHasFocus || isExpanded;

  return (
    <>
      <div
        className={cn(
          'pointer-events-none fixed inset-0 z-[240] bg-black/80 transition-opacity duration-220 ease-out',
          showBackdrop ? 'opacity-100' : 'opacity-0',
        )}
      />

      <div
        className={cn(
          'side-menu-panel fixed left-0 top-0 bottom-0 z-[260] border-r border-white/5 flex flex-col shadow-2xl transition-all ease-in-out',
          'bg-black/60 backdrop-blur-xl'
        )}
        style={{
          width: isExpanded ? expandedWidth : collapsedWidth,
          paddingTop: panelVerticalPadding,
          paddingBottom: Math.max(16, panelVerticalPadding - 8),
          borderRightWidth: 1,
          borderRightColor: 'rgba(255,255,255,0.05)',
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
          className="h-10 flex items-center shrink-0"
          style={{
            paddingLeft: panelHorizontalPadding + 8,
            paddingRight: panelHorizontalPadding + 8,
            marginBottom: logoBottomMargin,
          }}
        >
          <span className="text-red-600 font-display font-black text-2xl tracking-tighter italic">
            {isExpanded ? 'XANDEFLIX' : 'X'}
          </span>
        </div>

        {/* User Profile Section */}
        <div
          className="mb-4 shrink-0"
          style={{ paddingLeft: panelHorizontalPadding, paddingRight: panelHorizontalPadding }}
        >
          <div
            role="button"
            tabIndex={0}
            onFocus={() => handleFocus('profile')}
            onBlur={handleBlur}
            onClick={() => handlePress('profile')}
            data-nav-id="menu-profile"
            className={cn(
              "w-full flex flex-row items-center rounded-xl transition-all duration-300 outline-none border-none bg-transparent"
            )}
            style={{
              padding: layout.isTvProfile ? 8 : 10,
              backgroundColor: 'transparent',
              WebkitTapHighlightColor: 'transparent',
              justifyContent: isExpanded ? 'flex-start' : 'center',
            }}
          >
            <div
              className="flex flex-row items-center"
              style={{ width: isExpanded ? '100%' : 'auto', justifyContent: isExpanded ? 'flex-start' : 'center' }}
            >
              <div
                className="bg-gradient-to-br from-blue-600 to-indigo-800 rounded-lg flex items-center justify-center shadow-lg shrink-0"
                style={{ width: layout.isTvProfile ? 36 : 40, height: layout.isTvProfile ? 36 : 40 }}
              >
                <User color="white" size={layout.isTvProfile ? 22 : 24} />
              </div>
              {isExpanded && (
                isTvDevice ? (
                  <div
                    className="inline-block font-display font-bold text-white tracking-tight whitespace-nowrap"
                    style={{ marginLeft: layout.isTvProfile ? 12 : 16, fontSize: labelFontSize, textAlign: 'left' }}
                  >
                    Timbo
                  </div>
                ) : (
                  <div
                    className="inline-block font-display font-bold text-white tracking-tight whitespace-nowrap"
                    style={{ marginLeft: layout.isTvProfile ? 12 : 16, fontSize: labelFontSize, textAlign: 'left' }}
                  >
                    Timbo
                  </div>
                )
              )}
            </div>
          </div>
        </div>

        {/* Navigation Items */}
        <div
          className="flex-1 space-y-1 overflow-y-auto scrollbar-hide"
          style={{
            paddingLeft: panelHorizontalPadding,
            paddingRight: panelHorizontalPadding,
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
                  "w-full flex items-center rounded-xl transition-all duration-300 cursor-pointer group outline-none border-none bg-transparent",
                  isFocused ? "scale-110" : "opacity-70 scale-100"
                )}
                style={{
                  padding: itemPadding,
                  backgroundColor: 'transparent',
                  WebkitTapHighlightColor: 'transparent',
                  transformOrigin: 'center center',
                  justifyContent: isExpanded ? 'flex-start' : 'center',
                }}
              >
                <div
                  className="flex flex-row items-center"
                  style={{ width: isExpanded ? '100%' : 'auto', justifyContent: isExpanded ? 'flex-start' : 'center' }}
                >
                  <div className="w-8 flex items-center justify-center shrink-0 transition-transform duration-300 group-hover:scale-110">
                    <Icon 
                      size={iconSize} 
                      color={isHighlighted ? "#E50914" : "rgba(255,255,255,0.6)"} 
                      strokeWidth={isHighlighted ? 2.5 : 1.5}
                    />
                  </div>
                  {isExpanded && (
                    isTvDevice ? (
                      <div
                        className={cn(
                          "inline-block font-display tracking-tight transition-colors duration-300 whitespace-nowrap",
                          isHighlighted ? "text-white font-bold" : "text-gray-400 group-hover:text-white"
                        )}
                        style={{ marginLeft: layout.isTvProfile ? 12 : 16, fontSize: labelFontSize, textAlign: 'left' }}
                      >
                        {item.label}
                      </div>
                    ) : (
                      <div
                        className={cn(
                          "inline-block font-display tracking-tight transition-colors duration-300 whitespace-nowrap",
                          isHighlighted ? "text-white font-bold" : "text-gray-400 group-hover:text-white"
                        )}
                        style={{ marginLeft: layout.isTvProfile ? 12 : 16, fontSize: labelFontSize, textAlign: 'left' }}
                      >
                        {item.label}
                      </div>
                    )
                  )}
                </div>
              </div>
            );
          })}


        </div>

        {/* Bottom Info */}
        <div
          className="border-t border-white/5 space-y-2 shrink-0"
          style={{
            paddingLeft: panelHorizontalPadding,
            paddingRight: panelHorizontalPadding,
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
              "w-full flex items-center rounded-xl transition-all duration-300 cursor-pointer group outline-none border-none bg-transparent",
              focusedItem === 'logout' ? "scale-110" : "opacity-70"
            )}
            style={{
              padding: itemPadding,
              backgroundColor: 'transparent',
              WebkitTapHighlightColor: 'transparent',
              transformOrigin: 'center center',
              justifyContent: isExpanded ? 'flex-start' : 'center',
            }}
          >
            <div
              className="flex flex-row items-center"
              style={{ width: isExpanded ? '100%' : 'auto', justifyContent: isExpanded ? 'flex-start' : 'center' }}
            >
              <div className="w-8 flex items-center justify-center shrink-0 transition-transform duration-300 group-hover:scale-110">
                <LogOut 
                  size={iconSize} 
                  color={focusedItem === 'logout' ? "#E50914" : "rgba(255,255,255,0.6)"} 
                />
              </div>
              {isExpanded && (
                isTvDevice ? (
                  <div
                    className={cn(
                      "inline-block font-display tracking-tight transition-colors duration-300 whitespace-nowrap",
                      focusedItem === 'logout' ? "text-red-500 font-bold" : "text-gray-400 group-hover:text-red-500"
                    )}
                    style={{ marginLeft: layout.isTvProfile ? 12 : 16, fontSize: labelFontSize, textAlign: 'left' }}
                  >
                    Sair
                  </div>
                ) : (
                  <motion.div
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    className={cn(
                      "inline-block font-display tracking-tight transition-colors duration-300 whitespace-nowrap",
                      focusedItem === 'logout' ? "text-red-500 font-bold" : "text-gray-400 group-hover:text-red-500"
                    )}
                    style={{ marginLeft: layout.isTvProfile ? 12 : 16, fontSize: labelFontSize, textAlign: 'left' }}
                  >
                    Sair
                  </motion.div>
                )
              )}
            </div>
          </div>

          {isExpanded && (
            isTvDevice ? (
              <div className="px-4">
                <span className="text-[10px] text-gray-500 uppercase tracking-widest font-display font-black opacity-50">
                  Xandeflix Premium v1.2
                </span>
              </div>
            ) : (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="px-4"
              >
                <span className="text-[10px] text-gray-500 uppercase tracking-widest font-display font-black opacity-50">
                  Xandeflix Premium v1.2
                </span>
              </motion.div>
            )
          )}
        </div>
      </div>
    </>
  );
};
