import React, { useCallback, useEffect, useState } from 'react';
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
        // Se houver modais abertos ou navegação interna, enviamos o Escape
        const hasOpenModals = document.querySelector('[role="dialog"], .modal-open, #player-overlay');
        
        if (hasOpenModals) {
          const escapeEvent = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
          window.dispatchEvent(escapeEvent);
          return;
        }

        // Se estiver na tela principal e não houver nada aberto, mostrar confirmação de saída
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

  if (isLoading) {
    return <LoadingScreen />;
  }

  if (!isAuthenticated) {
    return <LoginScreen onLoginSuccess={handleLoginSuccess} />;
  }

  return (
    <>
      <HomeScreen onLogout={handleLogout} />
      
      {showExitConfirmation && (
        <View style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.85)',
          justifyContent: 'center',
          alignItems: 'center',
          zIndex: 9999,
        }}>
          <View style={{
            width: 500,
            backgroundColor: '#1a1a1a',
            borderRadius: 20,
            padding: 40,
            borderWidth: 1,
            borderColor: 'rgba(255,255,255,0.1)',
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 10 },
            shadowOpacity: 0.5,
            shadowRadius: 20,
          }}>
            <Text style={{
              color: 'white',
              fontSize: 28,
              fontWeight: '900',
              textAlign: 'center',
              marginBottom: 16,
              fontFamily: 'Outfit',
            }}>Sair do Xandeflix?</Text>
            
            <Text style={{
              color: 'rgba(255,255,255,0.6)',
              fontSize: 18,
              textAlign: 'center',
              marginBottom: 40,
              lineHeight: 26,
              fontFamily: 'Outfit',
            }}>
              Sua programação atual será pausada. Tem certeza que deseja fechar o aplicativo?
            </Text>

            <View style={{ flexDirection: 'row', gap: 16 }}>
              <TouchableHighlight
                onPress={() => setShowExitConfirmation(false)}
                underlayColor="rgba(255,255,255,0.1)"
                style={{
                  flex: 1,
                  backgroundColor: 'rgba(255,255,255,0.05)',
                  borderRadius: 12,
                  paddingVertical: 18,
                  alignItems: 'center',
                }}
              >
                <Text style={{ color: 'white', fontSize: 18, fontWeight: '800', fontFamily: 'Outfit' }}>CONTINUAR ASSISTINDO</Text>
              </TouchableHighlight>

              <TouchableHighlight
                onPress={() => CapacitorApp.exitApp()}
                underlayColor="#dc2626"
                style={{
                  flex: 1,
                  backgroundColor: '#E50914',
                  borderRadius: 12,
                  paddingVertical: 18,
                  alignItems: 'center',
                }}
              >
                <Text style={{ color: 'white', fontSize: 18, fontWeight: '800', fontFamily: 'Outfit' }}>SAIR AGORA</Text>
              </TouchableHighlight>
            </View>
          </View>
        </View>
      )}
    </>
  );
}

