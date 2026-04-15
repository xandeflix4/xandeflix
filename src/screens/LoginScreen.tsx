import React, { useState, useEffect, useRef } from 'react';
import { ActivityIndicator } from 'react-native';
import { motion } from 'motion/react';
import { authenticateWithSupabase, type SessionSnapshot } from '../lib/auth';
import { APP_BUILD_LABEL } from '../lib/buildInfo';
import { useResponsiveLayout } from '../hooks/useResponsiveLayout';
import { useTvNavigation } from '../hooks/useTvNavigation';

interface LoginScreenProps {
  onLoginSuccess: (snapshot: SessionSnapshot) => void;
}

export const LoginScreen: React.FC<LoginScreenProps> = ({ onLoginSuccess }) => {
  const layout = useResponsiveLayout();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const idInputRef = useRef<HTMLInputElement>(null);
  const pwdInputRef = useRef<HTMLInputElement>(null);

  const { registerNode, setFocusedId, focusedId } = useTvNavigation({ isActive: true, subscribeFocused: true });

  const isTvProfile = layout.isTvProfile;
  const outerPaddingX = isTvProfile ? 18 : 20;
  const outerPaddingTop = isTvProfile ? 24 : 20;
  const outerPaddingBottom = isTvProfile ? 28 : 20;
  const shellMaxWidth = isTvProfile ? 360 : layout.isMobile ? 360 : 440;
  const logoSize = isTvProfile ? 48 : layout.isMobile ? 48 : 72;
  const logoLetterSpacing = isTvProfile ? -3 : -4;
  const logoMarginBottom = isTvProfile ? 2 : 4;
  const taglineFontSize = isTvProfile ? 11 : 14;
  const taglineLetterSpacing = isTvProfile ? 3 : 4;
  const taglineMarginBottom = isTvProfile ? 18 : 48;
  const panelPadding = isTvProfile ? 24 : layout.isMobile ? 24 : 48;
  const panelRadius = isTvProfile ? 18 : 24;
  const titleFontSize = isTvProfile ? 22 : layout.isMobile ? 24 : 32;
  const introFontSize = isTvProfile ? 13 : 15;
  const introLineHeight = isTvProfile ? '18px' : '22px';
  const introMarginBottom = isTvProfile ? 18 : 40;
  const fieldSpacing = isTvProfile ? 14 : 24;
  const passwordSpacing = isTvProfile ? 18 : 32;
  const labelFontSize = isTvProfile ? 11 : 12;
  const inputFontSize = isTvProfile ? 14 : 16;
  const inputPadding = isTvProfile ? '10px 12px' : '14px 16px';
  const buttonFontSize = isTvProfile ? 15 : 20;
  const buttonPadding = isTvProfile ? '13px 0' : '18px 0';
  const footerMarginTop = isTvProfile ? 16 : 32;
  const footerFontSize = isTvProfile ? 10 : 12;

  useEffect(() => {
    console.log('[LoginScreen] Renderizado.');
  }, []);

  const focusInputField = (input: HTMLInputElement | null) => {
    if (!input) return;
    input.focus();
    input.click();
    const cursorPos = input.value.length;
    input.setSelectionRange(cursorPos, cursorPos);
  };

  const handleLogin = async () => {
    if (!identifier.trim()) {
      setError('Informe seu email ou ID de acesso.');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const snapshot = await authenticateWithSupabase(identifier, password);
      onLoginSuccess(snapshot);
    } catch (err: any) {
      setError(err?.message || 'Nao foi possivel autenticar no Supabase.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setFocusedId('login-id');
    return () => {
      registerNode('login-id', null);
      registerNode('login-password', null);
      registerNode('login-submit', null);
    };
  }, [setFocusedId, registerNode]);

  const getInputStyle = (id: string): React.CSSProperties => ({
    width: '100%',
    boxSizing: 'border-box',
    backgroundColor: focusedId === id ? 'rgba(229, 9, 20, 0.08)' : 'rgba(255,255,255,0.05)',
    border: `2px solid ${focusedId === id ? '#E50914' : 'rgba(255,255,255,0.08)'}`,
    borderRadius: 8,
    padding: inputPadding,
    color: 'white',
    fontSize: inputFontSize,
    fontFamily: 'Outfit',
    outline: 'none',
    transition: 'all 0.2s ease',
    boxShadow: focusedId === id ? '0 0 15px rgba(229, 9, 20, 0.2)' : 'none',
    transform: focusedId === id ? 'scale(1.02)' : 'scale(1)',
  });

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        justifyContent: isTvProfile ? 'flex-start' : 'center',
        alignItems: 'center',
        backgroundColor: '#050505',
        minHeight: '100vh',
        paddingLeft: outerPaddingX,
        paddingRight: outerPaddingX,
        paddingTop: outerPaddingTop,
        paddingBottom: outerPaddingBottom,
        position: 'relative',
        overflowY: 'auto',
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          background:
            'radial-gradient(ellipse at 30% 20%, rgba(229,9,20,0.08) 0%, transparent 50%), radial-gradient(ellipse at 70% 80%, rgba(229,9,20,0.05) 0%, transparent 50%)',
        }}
      />

      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.6 }}
        style={{ width: '100%', maxWidth: shellMaxWidth, zIndex: 10 }}
      >
        <h1
          style={{
            fontSize: logoSize,
            fontWeight: 900,
            color: '#E50914',
            fontStyle: 'italic',
            letterSpacing: logoLetterSpacing,
            textAlign: 'center',
            margin: `0 0 ${logoMarginBottom}px`,
            fontFamily: 'Outfit',
          }}
        >
          XANDEFLIX
        </h1>
        <p
          style={{
            fontSize: taglineFontSize,
            color: 'rgba(255,255,255,0.3)',
            textAlign: 'center',
            letterSpacing: taglineLetterSpacing,
            textTransform: 'uppercase',
            marginBottom: taglineMarginBottom,
            fontFamily: 'Outfit',
          }}
        >
          Streaming Premium
        </p>

        <div
          style={{
            backgroundColor: '#0d0d0d',
            borderRadius: panelRadius,
            padding: panelPadding,
            border: '1px solid rgba(255,255,255,0.08)',
            boxShadow: '0 20px 50px rgba(0,0,0,0.5)',
          }}
        >
          <h2
            style={{
              fontSize: titleFontSize,
              fontWeight: 900,
              color: 'white',
              margin: '0 0 12px',
              fontFamily: 'Outfit',
              letterSpacing: -1,
            }}
          >
            Entrar
          </h2>
          <p style={{ fontSize: introFontSize, color: 'rgba(255,255,255,0.4)', marginBottom: introMarginBottom, lineHeight: introLineHeight }}>
            Use seu email ou ID de acesso para entrar.
          </p>

          <div style={{ marginBottom: fieldSpacing }}>
            <label
              style={{
                fontSize: labelFontSize,
                fontWeight: 900,
                color: focusedId === 'login-id' ? '#E50914' : 'rgba(255,255,255,0.4)',
                letterSpacing: 1.5,
                marginBottom: 10,
                fontFamily: 'Outfit',
                display: 'block',
                transition: 'color 0.2s',
              }}
            >
              EMAIL OU ID DE ACESSO
            </label>
            <input
              ref={(el) => {
                idInputRef.current = el;
                registerNode('login-id', el, 'body', {
                  onEnter: () => focusInputField(idInputRef.current),
                  disableAutoScroll: true,
                });
              }}
              type="text"
              placeholder="Seu email ou ID"
              value={identifier}
              onChange={(e) => {
                setIdentifier(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => e.key === 'Enter' && pwdInputRef.current?.focus()}
              autoCapitalize="none"
              autoComplete="username"
              style={getInputStyle('login-id')}
            />
          </div>

          <div style={{ marginBottom: passwordSpacing }}>
            <label
              style={{
                fontSize: labelFontSize,
                fontWeight: 900,
                color: focusedId === 'login-password' ? '#E50914' : 'rgba(255,255,255,0.4)',
                letterSpacing: 1.5,
                marginBottom: 10,
                fontFamily: 'Outfit',
                display: 'block',
                transition: 'color 0.2s',
              }}
            >
              SENHA
            </label>
            <input
              ref={(el) => {
                pwdInputRef.current = el;
                registerNode('login-password', el, 'body', {
                  onEnter: () => focusInputField(pwdInputRef.current),
                  disableAutoScroll: true,
                });
              }}
              type="password"
              placeholder="Sua senha de acesso"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
              autoComplete="current-password"
              style={getInputStyle('login-password')}
            />
          </div>

          {error && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
              <div
                style={{
                  backgroundColor: 'rgba(239,68,68,0.1)',
                  border: '1px solid rgba(239,68,68,0.2)',
                  borderRadius: 8,
                  padding: 12,
                  marginBottom: 20,
                }}
              >
                <p style={{ color: '#EF4444', fontSize: 14, fontWeight: 'bold', margin: 0 }}>{error}</p>
              </div>
            </motion.div>
          )}

          <button
            ref={(el) => registerNode('login-submit', el, 'body', { onEnter: handleLogin, disableAutoScroll: true })}
            onClick={handleLogin}
            disabled={loading}
            style={{
              width: '100%',
              backgroundColor: focusedId === 'login-submit' ? '#FF0000' : '#E50914',
              borderRadius: 12,
              padding: buttonPadding,
              marginTop: 8,
              border: `2px solid ${focusedId === 'login-submit' ? 'white' : 'transparent'}`,
              cursor: loading ? 'not-allowed' : 'pointer',
              opacity: loading ? 0.7 : 1,
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              transition: 'all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
              outline: 'none',
              transform: focusedId === 'login-submit' ? 'scale(1.05)' : 'scale(1)',
              boxShadow: focusedId === 'login-submit' ? '0 15px 30px rgba(229, 9, 20, 0.4)' : 'none',
            }}
          >
            {loading ? (
              <ActivityIndicator color="white" size="small" />
            ) : (
              <span style={{ color: 'white', fontSize: buttonFontSize, fontWeight: 900, fontFamily: 'Outfit' }}>
                Comecar a Assistir
              </span>
            )}
          </button>
        </div>

        <p
          style={{
            color: 'rgba(255,255,255,0.15)',
            fontSize: footerFontSize,
            textAlign: 'center',
            marginTop: footerMarginTop,
            letterSpacing: 1,
          }}
        >
          Xandeflix Premium 2026 | Build {APP_BUILD_LABEL}
        </p>
      </motion.div>
    </div>
  );
};
