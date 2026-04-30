import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, TouchableHighlight } from 'react-native';
import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { StatusBar } from '@capacitor/status-bar';
import { LoginScreen } from './screens/LoginScreen';
import HomeScreen from './screens/HomeScreen';
import { LoadingScreen } from './components/LoadingScreen';
import { getSessionSnapshot, signOutSupabaseSession, type SessionSnapshot } from './lib/auth';
import { detectTvEnvironment } from './lib/deviceProfile';
import { supabase } from './lib/supabase';
import { useStore } from './store/useStore';
import { getLastCrash, clearLastCrash } from './lib/crashReporter';
import { useTvNavigation } from './hooks/useTvNavigation';

const LEGACY_AUTH_STORAGE_KEYS = [
  'xandeflix_auth_token',
  'xandeflix_auth_role',
  'xandeflix_user_id',
  'xandeflix_session',
] as const;

function clearLegacyAuthStorage() {
  LEGACY_AUTH_STORAGE_KEYS.forEach((key) => localStorage.removeItem(key));

  const sessionKeysToRemove: string[] = [];
  for (let index = 0; index < sessionStorage.length; index += 1) {
    const key = sessionStorage.key(index);
    if (key?.startsWith('xandeflix_')) {
      sessionKeysToRemove.push(key);
    }
  }

  sessionKeysToRemove.forEach((key) => sessionStorage.removeItem(key));
}

export default function App() {
  console.log('[App] Render start.');
  const [isLoading, setIsLoading] = useState(true);
  const [sessionRole, setSessionRole] = useState<'admin' | 'user' | null>(null);
  const setIsAdminMode = useStore((state) => state.setIsAdminMode);
  const setIsTvMode = useStore((state) => state.setIsTvMode);
  const hydrateProfileState = useStore((state) => state.hydrateProfileState);
  const clearSessionState = useStore((state) => state.clearSessionState);
  const setAdultAccessSettings = useStore((state) => state.setAdultAccessSettings);
  const fetchEPG = useStore((state) => state.fetchEPG);
  const [hasCrashLog, setHasCrashLog] = useState(false);
  const [crashDetails, setCrashDetails] = useState<string | null>(null);
  const [showExitConfirmation, setShowExitConfirmation] = useState(false);
  const activeFilter = useStore((state) => state.activeFilter);
  const selectedCategoryName = useStore((state) => state.selectedCategoryName);
  const selectedMedia = useStore((state) => state.selectedMedia);
  const setActiveFilter = useStore((state) => state.setActiveFilter);
  const setSelectedCategoryName = useStore((state) => state.setSelectedCategoryName);
  const setSelectedMedia = useStore((state) => state.setSelectedMedia);

  const { registerNode, setFocusedId } = useTvNavigation({
    isActive: showExitConfirmation,
    onBack: () => setShowExitConfirmation(false),
  });
  const showExitConfirmationRef = useRef(showExitConfirmation);

  useEffect(() => {
    showExitConfirmationRef.current = showExitConfirmation;
  }, [showExitConfirmation]);

  useEffect(() => {
    if (!showExitConfirmation) return;
    // Pequeno delay para garantir que os nodes foram registrados no DOM
    const timerId = window.setTimeout(() => {
      setFocusedId('exit-cancel');
    }, 50);
    return () => window.clearTimeout(timerId);
  }, [showExitConfirmation, setFocusedId]);

  useEffect(() => {
    if (!showExitConfirmation) return;

    const modalNodeIds = ['exit-cancel', 'exit-confirm'] as const;
    type ModalNodeId = (typeof modalNodeIds)[number];

    const getFocusedModalNode = (): ModalNodeId | null => {
      const activeElement = document.activeElement as HTMLElement | null;
      const navId = activeElement?.dataset?.navId
        || activeElement?.closest('[data-nav-id]')?.getAttribute('data-nav-id')
        || null;
      if (navId === 'exit-cancel' || navId === 'exit-confirm') return navId;
      return null;
    };

    const focusModalNodeByIndex = (index: number) => {
      const safeIndex = (index + modalNodeIds.length) % modalNodeIds.length;
      setFocusedId(modalNodeIds[safeIndex]);
    };

    const activateFocusedModalNode = () => {
      const targetNavId = getFocusedModalNode() || 'exit-cancel';
      const element = document.querySelector<HTMLElement>(`[data-nav-id="${targetNavId}"]`);
      if (element) {
        element.click();
      }
    };

    const normalizeModalKey = (event: KeyboardEvent): string => {
      if (event.key === 'Escape' || event.key === 'Back') return 'Back';
      if (event.key === 'Enter' || event.key === 'OK') return 'Enter';
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        return event.key;
      }

      const keyCode = (event as KeyboardEvent & { keyCode?: number }).keyCode;
      if (keyCode === 4) return 'Back';
      if (keyCode === 13 || keyCode === 23 || keyCode === 66 || keyCode === 160) return 'Enter';
      if (keyCode === 21) return 'ArrowLeft';
      if (keyCode === 22) return 'ArrowRight';
      if (keyCode === 19) return 'ArrowUp';
      if (keyCode === 20) return 'ArrowDown';
      return '';
    };

    const trapModalNavigation = (event: KeyboardEvent) => {
      const key = normalizeModalKey(event);
      if (!key) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      if (key === 'Back') {
        setShowExitConfirmation(false);
        return;
      }

      if (key === 'Enter') {
        activateFocusedModalNode();
        return;
      }

      const currentFocusedNode = getFocusedModalNode();
      const currentIndex = currentFocusedNode ? modalNodeIds.indexOf(currentFocusedNode) : 0;

      if (key === 'ArrowLeft' || key === 'ArrowUp') {
        focusModalNodeByIndex(currentIndex - 1);
        return;
      }

      if (key === 'ArrowRight' || key === 'ArrowDown') {
        focusModalNodeByIndex(currentIndex + 1);
      }
    };

    window.addEventListener('keydown', trapModalNavigation, true);
    return () => window.removeEventListener('keydown', trapModalNavigation, true);
  }, [setFocusedId, showExitConfirmation]);

  useEffect(() => {
    const crash = getLastCrash();
    if (crash) {
      setHasCrashLog(true);
      setCrashDetails(`ERRO CRÍTICO DETECTADO\n\nData: ${crash.timestamp}\nMensagem: ${crash.message}\n\nStack: ${crash.stack?.substring(0, 400)}...`);
    }
  }, []);

  const handleClearCrashAndContinue = () => {
    clearLastCrash();
    setHasCrashLog(false);
    setCrashDetails(null);
  };

  useEffect(() => {
    const syncTvMode = () => {
      const isTv = detectTvEnvironment();
      setIsTvMode(isTv);

      // Aplica zoom CSS 70% na raiz do documento para TVs.
      // Isso encolhe TODOS os elementos uniformemente (fontes, ícones, cards, botões).
      // O Chromium WebView do Android suporta a propriedade CSS zoom nativamente.
      if (typeof document !== 'undefined') {
        document.documentElement.style.zoom = isTv ? '0.7' : '1';
      }
    };

    syncTvMode();
    window.addEventListener('resize', syncTvMode);

    return () => {
      window.removeEventListener('resize', syncTvMode);
    };
  }, [setIsTvMode]);

  useEffect(() => {
    if (Capacitor.isNativePlatform()) {
      const backButtonListener = CapacitorApp.addListener('backButton', ({ canGoBack }) => {
        if (showExitConfirmationRef.current) {
          setShowExitConfirmation(false);
          return;
        }

        // Se houver modais abertos ou navegação interna, enviamos o Escape
        const hasOpenModals = document.querySelector('[role="dialog"], .modal-open, #player-overlay, #exit-confirmation-modal');
        
        if (hasOpenModals) {
          const escapeEvent = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
          window.dispatchEvent(escapeEvent);
          return;
        }

        // Lê o estado ATUAL diretamente do store (evita stale closure do useEffect [])
        const currentState = useStore.getState();
        const currentFilter = currentState.activeFilter;
        const currentCategory = currentState.selectedCategoryName;
        const currentMedia = currentState.selectedMedia;
        const currentPlayer = currentState.playerMode;

        // Se o navegador de canais estiver aberto, apenas fecha o navegador
        if (currentState.isChannelBrowserOpen) {
          currentState.setIsChannelBrowserOpen(false);
          return;
        }

        // Se o player estiver aberto, fecha o player primeiro
        if (currentPlayer === 'fullscreen' || currentPlayer === 'minimized') {
          currentState.setIsChannelBrowserOpen(false);
          currentState.setFocusedId(null);
          currentState.setPlayerMode('closed');
          currentState.setActiveVideoUrl(null);
          currentState.setPlayingMedia(null);
          return;
        }

        // Se um media está selecionado (modal de detalhes), fecha o modal
        if (currentMedia !== null) {
          currentState.setSelectedMedia(null);
          return;
        }

        // Se uma categoria está expandida, volta para a lista de categorias
        if (currentCategory !== null) {
          currentState.setSelectedCategoryName(null);
          return;
        }

        // Se estiver em um filtro diferente de home (live, movie, series, search, etc.), volta para home
        if (currentFilter !== 'home') {
          currentState.setActiveFilter('home');
          return;
        }

        // Se já estiver na tela principal sem nada aberto, mostrar confirmação de saída
        setShowExitConfirmation(true);
      });

      const enforceFullscreen = async () => {
        try {
          await StatusBar.hide();
        } catch (statusBarError) {
          console.warn('[Fullscreen] Falha ao ocultar status bar:', statusBarError);
        }
      };

      void enforceFullscreen();

      const appStateListener = CapacitorApp.addListener('appStateChange', ({ isActive }) => {
        if (isActive) {
          void enforceFullscreen();
        }
      });

      return () => {
        backButtonListener.then(listener => listener.remove());
        appStateListener.then(listener => listener.remove());
      };
    }
  }, []);


  const resetSession = useCallback(() => {
    console.log('[AppBootstrap] Resetando sessao (logout/expirado).');
    clearLegacyAuthStorage();
    setSessionRole(null);
    setIsAdminMode(false);
    setAdultAccessSettings(null);
    clearSessionState();
  }, [clearSessionState, setAdultAccessSettings, setIsAdminMode]);

  const applySessionSnapshot = useCallback(
    (snapshot: SessionSnapshot) => {
      clearLegacyAuthStorage();
      setSessionRole(snapshot.role);
      setIsAdminMode(snapshot.role === 'admin');

      if (snapshot.role === 'user' && snapshot.data) {
        setAdultAccessSettings(snapshot.data.adultAccess);
        hydrateProfileState();
        
        if (snapshot.data.epgUrl) {
          void fetchEPG(snapshot.data.epgUrl);
        }
      } else if (snapshot.role === 'admin') {
        // Admin nao tem perfil de usuario limitado, mas mantemos o estado
        setAdultAccessSettings({ enabled: true, totpEnabled: false });
        hydrateProfileState();
        
        // Para admin, tentamos restaurar o ultimo EPG usado se disponivel
        const lastEpg = useStore.getState().lastEpgUrl;
        if (lastEpg) {
          void fetchEPG(lastEpg);
        }
      } else {
        setAdultAccessSettings(null);
        clearSessionState();
      }
    },
    [clearSessionState, hydrateProfileState, setAdultAccessSettings, setIsAdminMode, fetchEPG],
  );

  useEffect(() => {
    let isMounted = true;

    const restoreSession = async () => {
      try {
        const snapshot = await getSessionSnapshot();

        if (!isMounted) {
          return;
        }

        if (!snapshot) {
          resetSession();
        } else {
          applySessionSnapshot(snapshot);
        }
      } catch (error) {
        console.error('[AppBootstrap] Falha ao restaurar sessao inicial:', error);
        if (!isMounted) {
          return;
        }
        resetSession();
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    };

    void restoreSession();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!isMounted) {
        return;
      }

      if (!session) {
        resetSession();
        setIsLoading(false);
        return;
      }

      void (async () => {
        try {
          const snapshot = await getSessionSnapshot();
          if (!isMounted) {
            return;
          }

          if (!snapshot) {
            resetSession();
          } else {
            applySessionSnapshot(snapshot);
          }
        } catch (error) {
          console.error('[AppBootstrap] Falha ao sincronizar sessao no auth listener:', error);
          if (!isMounted) {
            return;
          }
          resetSession();
        } finally {
          if (isMounted) {
            setIsLoading(false);
          }
        }
      })();
    });

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, [applySessionSnapshot, resetSession]);

  const handleLoginSuccess = useCallback(
    (snapshot: SessionSnapshot) => {
      applySessionSnapshot(snapshot);
      setIsLoading(false);
    },
    [applySessionSnapshot],
  );

  const handleLogout = useCallback(() => {
    resetSession();
    setIsLoading(false);
    void signOutSupabaseSession();
  }, [resetSession]);

  const isAuthenticated = sessionRole !== null;

  useEffect(() => {
    console.log('[App] Estado de renderizacao:', {
      isLoading,
      sessionRole,
      hasCrashLog,
      isAuthenticated,
    });
  }, [hasCrashLog, isAuthenticated, isLoading, sessionRole]);

  useEffect(() => {
    (window as any).__xandeflixAppMounted = true;
    console.log('[App] Componente montado.');
  }, []);

  if (hasCrashLog) {
    return (
      <View style={{ flex: 1, backgroundColor: '#050505', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <View style={{ maxWidth: 600, width: '100%', backgroundColor: '#1a1a1a', borderRadius: 16, padding: 32, borderLeftWidth: 4, borderLeftColor: '#ef4444' }}>
          <Text style={{ fontSize: 28, fontWeight: '900', color: '#ef4444', marginBottom: 16 }}>RECUPERAÇÃO DE FALHA</Text>
          <Text style={{ fontSize: 16, color: '#aaa', marginBottom: 24 }}>Detectamos que o aplicativo fechou inesperadamente no último acesso. Para evitar um loop de erros, pausamos o carregamento automático.</Text>
          
          <View style={{ backgroundColor: '#000', borderRadius: 8, padding: 16, marginBottom: 32 }}>
            <Text style={{ color: '#f87171', fontFamily: 'monospace', fontSize: 12 }}>{crashDetails}</Text>
          </View>

          <TouchableHighlight
            onPress={handleClearCrashAndContinue}
            underlayColor="#dc2626"
            style={{ backgroundColor: '#ef4444', borderRadius: 12, paddingVertical: 18, alignItems: 'center' }}
          >
            <Text style={{ color: '#fff', fontSize: 18, fontWeight: '800' }}>LIMPAR LOG E CONTINUAR</Text>
          </TouchableHighlight>
          
          <TouchableHighlight
            onPress={() => {
               handleLogout();
               handleClearCrashAndContinue();
            }}
            underlayColor="rgba(255,255,255,0.1)"
            style={{ borderRadius: 12, paddingVertical: 18, alignItems: 'center', marginTop: 12 }}
          >
            <Text style={{ color: '#fff', fontSize: 16, fontWeight: '600', opacity: 0.6 }}>LOGOUT E LIMPAR TUDO</Text>
          </TouchableHighlight>
        </View>
      </View>
    );
  }

  let mainContent;
  if (isLoading) {
    mainContent = <LoadingScreen />;
  } else if (!isAuthenticated) {
    mainContent = <LoginScreen onLoginSuccess={handleLoginSuccess} />;
  } else {
    mainContent = <HomeScreen onLogout={handleLogout} />;
  }

  return (
    <>
      {mainContent}
      
      {showExitConfirmation && (
        <View
          id="exit-confirmation-modal"
          style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.96)',
          justifyContent: 'center',
          alignItems: 'center',
          paddingHorizontal: 18,
          paddingVertical: 24,
          zIndex: 9999,
        }}>
          <View style={{
            width: '100%',
            maxWidth: 520,
            backgroundColor: '#181818',
            borderRadius: 24,
            paddingTop: 24,
            paddingHorizontal: 24,
            paddingBottom: 22,
            borderWidth: 1,
            borderColor: 'rgba(255,255,255,0.12)',
            alignItems: 'center',
            justifyContent: 'flex-start',
            minHeight: 0,
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 18 },
            shadowOpacity: 0.7,
            shadowRadius: 32,
            elevation: 24,
          }}>
            <View style={{
              width: 46,
              height: 4,
              backgroundColor: '#E50914',
              borderRadius: 2,
              marginBottom: 18,
            }} />
            
            <Text style={{
              color: 'white',
              fontSize: 24,
              fontWeight: '900',
              textAlign: 'center',
              marginBottom: 10,
              fontFamily: 'Outfit',
            }}>Sair do Xandeflix?</Text>
            
            <div style={{
              width: '100%',
              maxWidth: 420,
              marginBottom: 20,
              textAlign: 'center',
              color: 'rgba(255,255,255,0.75)',
              fontSize: 15,
              lineHeight: '20px',
              fontFamily: 'Outfit, sans-serif',
            }}>
              <div>Sua programação atual será pausada.</div>
              <div style={{ marginTop: 6 }}>Deseja realmente fechar o aplicativo?</div>
            </div>

            <View style={{ 
              flexDirection: 'row', 
              gap: 10, 
              width: '100%',
              maxWidth: 430,
              height: 50,
              marginTop: 2,
              paddingHorizontal: 16,
            }}>
              <TouchableHighlight
                ref={(ref) => registerNode('exit-cancel', ref as any, 'modal-exit', {
                  onEnter: () => setShowExitConfirmation(false),
                  onLeft: () => setFocusedId('exit-confirm'),
                  onRight: () => setFocusedId('exit-confirm'),
                  onUp: () => setFocusedId('exit-confirm'),
                  onDown: () => setFocusedId('exit-confirm'),
                  onBack: () => setShowExitConfirmation(false),
                })}
                onPress={() => setShowExitConfirmation(false)}
                underlayColor="rgba(255,255,255,0.15)"
                style={{
                  flex: 1,
                  backgroundColor: 'rgba(255,255,255,0.08)',
                  borderRadius: 10,
                  justifyContent: 'center',
                  alignItems: 'center',
                  borderWidth: 1,
                  borderColor: 'rgba(255,255,255,0.05)',
                }}
              >
                <Text style={{ color: 'white', fontSize: 14, fontWeight: '900', fontFamily: 'Outfit' }}>VOLTAR</Text>
              </TouchableHighlight>

              <TouchableHighlight
                ref={(ref) => registerNode('exit-confirm', ref as any, 'modal-exit', {
                  onEnter: () => CapacitorApp.exitApp(),
                  onLeft: () => setFocusedId('exit-cancel'),
                  onRight: () => setFocusedId('exit-cancel'),
                  onUp: () => setFocusedId('exit-cancel'),
                  onDown: () => setFocusedId('exit-cancel'),
                  onBack: () => setShowExitConfirmation(false),
                })}
                onPress={() => CapacitorApp.exitApp()}
                underlayColor="#b91c1c"
                style={{
                  flex: 1,
                  backgroundColor: '#E50914',
                  borderRadius: 10,
                  justifyContent: 'center',
                  alignItems: 'center',
                }}
              >
                <Text style={{ color: 'white', fontSize: 14, fontWeight: '900', fontFamily: 'Outfit' }}>SAIR AGORA</Text>
              </TouchableHighlight>
            </View>
          </View>

          {/* Adicionando estilo CSS inline para corrigir o contorno nos botões do modal especificamente */}
          <style dangerouslySetInnerHTML={{ __html: `
            [data-nav-id="exit-cancel"]:focus, [data-nav-id="exit-confirm"]:focus {
              outline: none !important;
              box-shadow: 0 0 0 2px #E50914, 0 0 10px rgba(229, 9, 20, 0.28) !important;
              transform: scale(1) !important;
            }
          `}} />
        </View>
      )}
    </>
  );
}
