import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, TouchableHighlight, StyleSheet, ScrollView, ActivityIndicator } from 'react-native';
import { Wifi, WifiOff, Globe, Signal, AlertTriangle, CheckCircle2, XCircle, Search, RefreshCw, X } from 'lucide-react';
import { useStore } from '../store/useStore';

interface DiagnosticResult {
  title: string;
  status: 'pending' | 'success' | 'error' | 'warning';
  message: string;
  details?: string;
  icon: React.ElementType;
}

export const NetworkDiagnostic: React.FC<{ onClose: () => void, testUrl?: string }> = ({ onClose, testUrl }) => {
  const [results, setResults] = useState<DiagnosticResult[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const isTvMode = useStore((state) => state.isTvMode);

  const addLog = (msg: string) => {
    setLogs(prev => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...prev]);
  };

  const runDiagnostics = useCallback(async () => {
    setIsRunning(true);
    setResults([]);
    setLogs([]);
    addLog('Iniciando diagnóstico completo...');

    const newResults: DiagnosticResult[] = [];

    // 1. Conexão Local
    const isOnline = navigator.onLine;
    newResults.push({
      title: 'Conexão Local',
      status: isOnline ? 'success' : 'error',
      message: isOnline ? 'Dispositivo conectado à rede' : 'Dispositivo offline',
      icon: isOnline ? Wifi : WifiOff
    });
    addLog(`Status da rede: ${isOnline ? 'ONLINE' : 'OFFLINE'}`);

    // 2. Acesso à Internet (Ping)
    addLog('Testando acesso à internet (Cloudflare/Google)...');
    try {
      const start = Date.now();
      await fetch('https://1.1.1.1', { mode: 'no-cors', cache: 'no-store' });
      const latency = Date.now() - start;
      newResults.push({
        title: 'Acesso à Internet',
        status: 'success',
        message: `Conexão estável (${latency}ms)`,
        icon: Globe
      });
      addLog(`Ping bem sucedido: ${latency}ms`);
    } catch (e) {
      newResults.push({
        title: 'Acesso à Internet',
        status: 'error',
        message: 'Falha ao conectar com servidores externos',
        icon: Globe
      });
      addLog('Erro ao pingar servidor externo. Pode haver bloqueio de DNS ou firewall.');
    }

    // 3. DNS e APIs Essenciais
    addLog('Verificando APIs do sistema...');
    try {
      await fetch('https://www.google.com/generate_204', { mode: 'no-cors' });
      newResults.push({
        title: 'Resolução de Nomes (DNS)',
        status: 'success',
        message: 'DNS funcionando corretamente',
        icon: Search
      });
    } catch (e) {
      newResults.push({
        title: 'Resolução de Nomes (DNS)',
        status: 'warning',
        message: 'Possível lentidão ou falha de DNS',
        icon: AlertTriangle
      });
    }

    // 4. Teste de Sinal (URL Específica)
    if (testUrl) {
      addLog(`Testando sinal do canal: ${testUrl.substring(0, 50)}...`);
      try {
        const start = Date.now();
        // We use mode: 'no-cors' to avoid CORS issues if trying to test a direct stream
        const response = await fetch(testUrl, { method: 'HEAD', mode: 'no-cors' });
        const latency = Date.now() - start;
        newResults.push({
          title: 'Sinal do Canal',
          status: 'success',
          message: `O servidor respondeu (${latency}ms)`,
          icon: Signal
        });
        addLog(`Sinal detectado! Latência: ${latency}ms`);
      } catch (e) {
        newResults.push({
          title: 'Sinal do Canal',
          status: 'error',
          message: 'O servidor do canal não respondeu',
          icon: Signal
        });
        addLog('ERRO: O link do canal está OFF ou bloqueado pelo seu provedor.');
      }
    }

    setResults([...newResults]);
    setIsRunning(false);
    addLog('Diagnóstico finalizado.');
  }, [testUrl]);

  useEffect(() => {
    runDiagnostics();
  }, [runDiagnostics]);

  return (
    <View style={styles.overlay}>
      <View style={styles.modal}>
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>Diagnóstico de Rede e Sinal</Text>
            <Text style={styles.subtitle}>Verificando integridade da conexão do Xandeflix</Text>
          </View>
          <TouchableHighlight 
            onPress={onClose}
            underlayColor="rgba(255,255,255,0.1)"
            style={styles.closeButton}
          >
            <View style={styles.closeButtonInner}>
              <X size={20} color="white" />
              <Text style={styles.closeButtonText}>Sair</Text>
            </View>
          </TouchableHighlight>
        </View>

        <View style={styles.content}>
          <View style={styles.statusList}>
            <Text style={styles.sectionTitle}>Status do Sistema</Text>
            {results.map((res, i) => (
              <View key={i} style={styles.resultItem}>
                <View style={[styles.iconContainer, (styles as any)[`icon_${res.status}`]]}>
                  <res.icon size={20} color={res.status === 'success' ? '#4ade80' : res.status === 'error' ? '#f87171' : '#fbbf24'} />
                </View>
                <View style={styles.resultText}>
                  <Text style={styles.resultTitle}>{res.title}</Text>
                  <Text style={styles.resultMessage}>{res.message}</Text>
                </View>
                {res.status === 'success' ? <CheckCircle2 size={18} color="#4ade80" /> : <XCircle size={18} color="#f87171" />}
              </View>
            ))}

            {isRunning && (
              <View style={styles.loadingContainer}>
                <ActivityIndicator color="#E50914" />
                <Text style={styles.loadingText}>Executando testes ativos...</Text>
              </View>
            )}

            <TouchableHighlight
              onPress={runDiagnostics}
              disabled={isRunning}
              underlayColor="rgba(229, 9, 20, 0.8)"
              style={[styles.retryButton, isRunning && { opacity: 0.5 }]}
            >
              <View style={styles.retryButtonInner}>
                <RefreshCw size={18} color="white" />
                <Text style={styles.retryButtonText}>Repetir Testes</Text>
              </View>
            </TouchableHighlight>
          </View>

          <View style={styles.logContainer}>
            <Text style={styles.sectionTitle}>Logs em Tempo Real</Text>
            <ScrollView style={styles.logScroll}>
              {logs.map((log, i) => (
                <Text key={i} style={styles.logText}>{log}</Text>
              ))}
              {logs.length === 0 && <Text style={styles.logPlaceholder}>Iniciando logs...</Text>}
            </ScrollView>
          </View>
        </View>

        <View style={styles.footer}>
          <View style={styles.infoBox}>
            <AlertTriangle size={16} color="#fbbf24" />
            <Text style={styles.infoText}>
              Se a Internet estiver OK mas os canais não abrirem, verifique se a lista M3U é válida ou se há bloqueio do provedor (ISP).
            </Text>
          </View>
        </View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.95)',
    zIndex: 9999,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 40,
  },
  modal: {
    width: '100%',
    maxWidth: 900,
    height: '80%',
    backgroundColor: '#0f0f0f',
    borderRadius: 32,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    overflow: 'hidden',
  },
  header: {
    padding: 40,
    paddingBottom: 20,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  title: {
    fontSize: 28,
    fontWeight: '900',
    color: '#ffffff',
    letterSpacing: -1,
  },
  subtitle: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.4)',
    marginTop: 6,
  },
  closeButton: {
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  closeButtonInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  closeButtonText: {
    color: '#ffffff',
    fontWeight: '800',
    fontSize: 14,
  },
  content: {
    flex: 1,
    flexDirection: 'row',
    padding: 40,
    paddingTop: 20,
    gap: 40,
  },
  statusList: {
    flex: 1.2,
  },
  logContainer: {
    flex: 1,
    backgroundColor: '#050505',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.05)',
    padding: 24,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: '900',
    color: 'rgba(255,255,255,0.3)',
    textTransform: 'uppercase',
    letterSpacing: 2,
    marginBottom: 20,
  },
  resultItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.02)',
    borderRadius: 20,
    padding: 20,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.04)',
  },
  iconContainer: {
    width: 44,
    height: 44,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 20,
  },
  icon_success: { backgroundColor: 'rgba(74, 222, 128, 0.08)' },
  icon_error: { backgroundColor: 'rgba(248, 113, 113, 0.08)' },
  icon_warning: { backgroundColor: 'rgba(251, 191, 36, 0.08)' },
  icon_pending: { backgroundColor: 'rgba(255, 255, 255, 0.03)' },
  resultText: {
    flex: 1,
  },
  resultTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#ffffff',
  },
  resultMessage: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.4)',
    marginTop: 4,
  },
  logScroll: {
    flex: 1,
  },
  logText: {
    fontFamily: 'monospace',
    fontSize: 12,
    color: '#34d399',
    marginBottom: 8,
    lineHeight: 18,
    opacity: 0.8,
  },
  logPlaceholder: {
    color: 'rgba(255,255,255,0.1)',
    fontSize: 13,
  },
  loadingContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 30,
    gap: 16,
  },
  loadingText: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 15,
  },
  retryButton: {
    marginTop: 20,
    backgroundColor: '#E50914',
    borderRadius: 18,
    height: 60,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#E50914',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
  },
  retryButtonInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  retryButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '900',
  },
  footer: {
    padding: 40,
    paddingTop: 0,
  },
  infoBox: {
    flexDirection: 'row',
    backgroundColor: 'rgba(251, 191, 36, 0.04)',
    borderRadius: 16,
    padding: 20,
    gap: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(251, 191, 36, 0.1)',
  },
  infoText: {
    flex: 1,
    fontSize: 13,
    color: 'rgba(251, 191, 36, 0.7)',
    lineHeight: 20,
  }
});
