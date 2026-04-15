import React, { useEffect } from 'react';
import { motion } from 'motion/react';
import { useResponsiveLayout } from '../hooks/useResponsiveLayout';

interface LoadingScreenProps {
  message?: string;
  details?: string;
  progress?: number;
  logs?: string[];
}

export const LoadingScreen: React.FC<LoadingScreenProps> = ({ message, details, progress, logs }) => {
  const layout = useResponsiveLayout();
  const hasExplicitProgress = typeof progress === 'number' && Number.isFinite(progress);
  const normalizedProgress = hasExplicitProgress
    ? Math.max(0, Math.min(100, Math.round(progress as number)))
    : 0;
  const visibleLogs = (logs || []).slice(-6);
  const isTvProfile = layout.isTvProfile;
  const logoSize = isTvProfile ? 64 : 84;
  const logoLetterSpacing = isTvProfile ? -3 : -5;
  const progressWidth = isTvProfile ? 280 : 340;
  const statusFontSize = isTvProfile ? 14 : 16;
  const detailsFontSize = isTvProfile ? 11 : 12;
  const logsWidth = isTvProfile ? 360 : 420;

  useEffect(() => {
    console.log('[LoadingScreen] Renderizado:', {
      message: message || 'Iniciando Sistema',
      hasDetails: Boolean(details),
      progress: hasExplicitProgress ? normalizedProgress : null,
      logsCount: visibleLogs.length,
    });
  }, [details, hasExplicitProgress, message, normalizedProgress, visibleLogs.length]);

  return (
    <div
      style={{
        width: '100%',
        minHeight: '100vh',
        backgroundColor: '#050505',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        position: 'fixed',
        top: 0,
        left: 0,
        zIndex: 9999,
        padding: isTvProfile ? '24px 18px' : 24,
      }}
    >
      <div
        style={{
          position: 'absolute',
          width: '60vw',
          height: '60vw',
          background: 'radial-gradient(circle, rgba(229, 9, 20, 0.1) 0%, transparent 70%)',
          filter: 'blur(100px)',
          zIndex: -1,
        }}
      />

      <motion.div
        animate={{
          scale: [1, 1.05, 1],
          opacity: [0.8, 1, 0.8],
        }}
        transition={{
          duration: 3,
          repeat: Infinity,
          ease: 'easeInOut',
        }}
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          width: '100%',
          maxWidth: isTvProfile ? 420 : 520,
        }}
      >
        <h1
          style={{
            fontSize: logoSize,
            fontWeight: 900,
            color: '#E50914',
            fontStyle: 'italic',
            letterSpacing: logoLetterSpacing,
            margin: 0,
            fontFamily: 'Outfit',
            textShadow: '0 0 30px rgba(229, 9, 20, 0.3)',
          }}
        >
          XANDEFLIX
        </h1>

        <div
          style={{
            width: progressWidth,
            maxWidth: '100%',
            height: 4,
            backgroundColor: 'rgba(255, 255, 255, 0.1)',
            marginTop: isTvProfile ? 28 : 40,
            borderRadius: 2,
            overflow: 'hidden',
            position: 'relative',
          }}
        >
          {hasExplicitProgress ? (
            <motion.div
              animate={{ width: `${normalizedProgress}%` }}
              transition={{ duration: 0.35, ease: 'easeOut' }}
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                height: '100%',
                background: 'linear-gradient(90deg, #E50914, #ff3542)',
              }}
            />
          ) : (
            <motion.div
              animate={{ width: ['12%', '64%', '30%'] }}
              transition={{ duration: 2.2, repeat: Infinity, ease: 'easeInOut' }}
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                height: '100%',
                background: 'linear-gradient(90deg, #E50914, #ff3542)',
              }}
            />
          )}

          <motion.div
            animate={{ left: ['-100%', '100%'] }}
            transition={{
              duration: 2,
              repeat: Infinity,
              ease: 'easeInOut',
            }}
            style={{
              position: 'absolute',
              width: '50%',
              height: '100%',
              background: 'linear-gradient(90deg, transparent, #E50914, transparent)',
              opacity: 0.8,
            }}
          />
        </div>

        {hasExplicitProgress && (
          <Text
            style={{
              color: 'rgba(255, 255, 255, 0.85)',
              fontSize: isTvProfile ? 12 : 13,
              marginTop: 10,
              fontWeight: '700',
              fontFamily: 'Outfit',
              letterSpacing: 1.2,
            }}
          >
            {normalizedProgress}%
          </Text>
        )}

        <div style={{ marginTop: isTvProfile ? 20 : 24, alignItems: 'center', display: 'flex', flexDirection: 'column' }}>
          <Text
            style={{
              color: 'white',
              fontSize: statusFontSize,
              fontWeight: '900',
              fontFamily: 'Outfit',
              letterSpacing: isTvProfile ? 1.4 : 2,
              textTransform: 'uppercase',
              opacity: 0.9,
              textAlign: 'center',
            }}
          >
            {message || 'Iniciando Sistema'}
          </Text>

          {details && (
            <Text
              style={{
                color: 'rgba(255, 255, 255, 0.4)',
                fontSize: detailsFontSize,
                marginTop: 8,
                fontFamily: 'Outfit',
                width: progressWidth,
                maxWidth: '100%',
                textAlign: 'center',
              }}
            >
              {details}
            </Text>
          )}
        </div>

        {visibleLogs.length > 0 && (
          <div
            style={{
              marginTop: 16,
              width: logsWidth,
              maxWidth: '100%',
              backgroundColor: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 10,
              padding: '10px 12px',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            }}
          >
            {visibleLogs.map((line, index) => (
              <Text
                key={`${index}-${line.slice(0, 16)}`}
                style={{
                  color: 'rgba(255,255,255,0.78)',
                  fontSize: isTvProfile ? 10 : 11,
                  fontFamily: 'monospace',
                  lineHeight: '15px',
                  whiteSpace: 'pre-wrap',
                }}
              >
                {line}
              </Text>
            ))}
          </div>
        )}
      </motion.div>
    </div>
  );
};

const Text = ({ children, style }: any) => <span style={style}>{children}</span>;
