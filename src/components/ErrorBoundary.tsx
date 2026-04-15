import React, { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[ErrorBoundary] Erro capturado:', error, errorInfo);
    console.log('[ErrorBoundary] Mensagem simplificada:', error?.message || 'erro desconhecido');
  }

  private handleReload = () => {
    window.location.reload();
  };

  public render() {
    if (this.state.hasError) {
      return (
        <div
          className="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-[#050505] text-white p-8 text-center animate-in fade-in duration-500"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 9999,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: '#050505',
            color: '#ffffff',
            padding: 24,
            textAlign: 'center',
          }}
        >
          <div
            className="mb-8 p-4 rounded-full bg-red-600/10 border border-red-600/20"
            style={{
              marginBottom: 24,
              padding: 12,
              borderRadius: 999,
              border: '1px solid rgba(239,68,68,0.35)',
              backgroundColor: 'rgba(239,68,68,0.1)',
            }}
          >
            <svg 
              xmlns="http://www.w3.org/2000/svg" 
              width="48" height="48" 
              viewBox="0 0 24 24" 
              fill="none" 
              stroke="currentColor" 
              strokeWidth="2" 
              strokeLinecap="round" 
              strokeLinejoin="round" 
              className="text-red-500"
            >
              <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
              <path d="M12 9v4" />
              <path d="M12 17h.01" />
            </svg>
          </div>
          
          <h1
            className="text-4xl md:text-6xl font-black italic tracking-tighter text-red-600 mb-4"
            style={{ margin: 0, marginBottom: 12, fontSize: 42, fontWeight: 900, color: '#ef4444' }}
          >
            XANDEFLIX
          </h1>
          
          <h2 className="text-xl md:text-2xl font-bold mb-2" style={{ marginTop: 0, marginBottom: 8, fontSize: 26, fontWeight: 800 }}>
            Ops! Algo deu errado.
          </h2>
          <p
            className="max-w-md text-gray-400 mb-8 text-sm md:text-base leading-relaxed"
            style={{ marginTop: 0, marginBottom: 18, maxWidth: 700, color: 'rgba(255,255,255,0.8)', fontSize: 16 }}
          >
            Houve um problema ao carregar este componente. Nossa equipe de engenharia foi notificada (mentira, mas soa bem).
          </p>

          <button
            onClick={this.handleReload}
            className="px-8 py-3 bg-white text-black font-extrabold rounded-md hover:bg-gray-200 transition-colors focus:ring-4 focus:ring-red-600 outline-none"
            style={{
              minWidth: 220,
              minHeight: 48,
              borderRadius: 10,
              border: '1px solid rgba(255,255,255,0.2)',
              backgroundColor: '#ef4444',
              color: '#fff',
              fontSize: 16,
              fontWeight: 900,
              cursor: 'pointer',
              padding: '10px 22px',
            }}
          >
            RECARREGAR APLICATIVO
          </button>
          
          <div
            className="mt-12 opacity-20 text-[10px] uppercase tracking-widest font-mono"
            style={{ marginTop: 18, opacity: 0.75, fontSize: 12, fontFamily: 'monospace' }}
          >
            Error Code: {this.state.error?.name || 'GENERIC_CRASH'}
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
