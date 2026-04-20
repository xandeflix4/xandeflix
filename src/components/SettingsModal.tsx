import React, { useEffect, useMemo, useState } from 'react';
import { Modal, ScrollView, StyleSheet, Text, TextInput, TouchableHighlight, View } from 'react-native';
import { Check, KeyRound, Link, List, RefreshCw, RotateCcw, Save, Shield, X } from 'lucide-react';
import { Category } from '../types';
import { useStore } from '../store/useStore';
import { isAdultCategory } from '../lib/adultContent';
import { saveAdultAccessPassword, verifyAdultAccessPassword } from '../lib/adultAccess';
import { clearPlaylistCache } from '../lib/localCache';
import { clearTMDBMetadataCache } from '../lib/tmdbCache';
import { usePlaylist } from '../hooks/usePlaylist';
import { useTvNavigation } from '../hooks/useTvNavigation';

interface SettingsModalProps {
  isVisible: boolean;
  onClose: () => void;
  onSave: (url: string, hiddenIds: string[]) => void;
  onLogout?: () => void;
  allCategories: Category[];
  hiddenCategoryIds: string[];
}

type SettingsTab = 'general' | 'categories' | 'adult';

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isVisible,
  onClose,
  onSave,
  onLogout,
  allCategories,
  hiddenCategoryIds,
}) => {
  const adultAccess = useStore((state) => state.adultAccess);
  const isAdultUnlocked = useStore((state) => state.isAdultUnlocked);
  const setAdultAccessSettings = useStore((state) => state.setAdultAccessSettings);
  const unlockAdultContent = useStore((state) => state.unlockAdultContent);
  const lockAdultContent = useStore((state) => state.lockAdultContent);
  const { fetchPlaylist } = usePlaylist();

  const [localHiddenIds, setLocalHiddenIds] = useState<string[]>(hiddenCategoryIds);
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [loadingAction, setLoadingAction] = useState<string | null>(null);

  const [unlockPassword, setUnlockPassword] = useState('');
  const [createPassword, setCreatePassword] = useState('');
  const [createPasswordConfirm, setCreatePasswordConfirm] = useState('');
  const [changeCurrentPassword, setChangeCurrentPassword] = useState('');
  const [changeNewPassword, setChangeNewPassword] = useState('');
  const [changeNewPasswordConfirm, setChangeNewPasswordConfirm] = useState('');
  const adultCategoryCount = useMemo(
    () => allCategories.filter((category) => isAdultCategory(category)).length,
    [allCategories],
  );
  const adultLocked = !adultAccess.enabled || !isAdultUnlocked;

  useEffect(() => {
    setLocalHiddenIds(hiddenCategoryIds);
  }, [hiddenCategoryIds, isVisible]);


  useEffect(() => {
    if (!isVisible) {
      setActiveTab('general');
      setStatusMessage(null);
      setErrorMessage(null);
      setLoadingAction(null);
      setUnlockPassword('');
      setCreatePassword('');
      setCreatePasswordConfirm('');
      setChangeCurrentPassword('');
      setChangeNewPassword('');
      setChangeNewPasswordConfirm('');
    }
  }, [isVisible]);

  const setFeedback = (message?: string, error?: string) => {
    setStatusMessage(message || null);
    setErrorMessage(error || null);
  };

  const handleSave = () => {
    onSave('', localHiddenIds); // currentUrl handled internally by admin now
    onClose();
  };

  const handleRefreshPlaylist = async () => {
    setLoadingAction('refresh');
    setFeedback();
    try {
      await clearPlaylistCache();
      await fetchPlaylist();
      setFeedback('Lista sincronizada com sucesso!');
    } catch (error: any) {
      setFeedback(undefined, 'Falha ao sincronizar: ' + error.message);
    } finally {
      setLoadingAction(null);
    }
  };

  const handleClearMetadataCache = async () => {
    setLoadingAction('clear-tmdb');
    setFeedback();
    try {
      await clearTMDBMetadataCache();
      setFeedback('Cache de imagens e posters limpo!');
    } catch (error: any) {
      setFeedback(undefined, 'Erro ao limpar cache: ' + error.message);
    } finally {
      setLoadingAction(null);
    }
  };

  const toggleLocalCategory = (id: string) => {
    setLocalHiddenIds((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
  };

  const handleAdultUnlock = async () => {
    if (!unlockPassword.trim()) {
      setFeedback(undefined, 'Informe a senha do conteudo adulto.');
      return;
    }

    setLoadingAction('unlock');
    setFeedback();
    try {
      const adultAccessSettings = await verifyAdultAccessPassword(unlockPassword);
      setAdultAccessSettings(adultAccessSettings);
      unlockAdultContent();
      setUnlockPassword('');
      setFeedback('Conteudo adulto liberado nesta sessao.');
    } catch (error: any) {
      setFeedback(undefined, error.message);
    } finally {
      setLoadingAction(null);
    }
  };

  const handleAdultPasswordSave = async () => {
    const changing = adultAccess.enabled;
    const nextPassword = (changing ? changeNewPassword : createPassword).trim();
    const confirmPassword = (changing ? changeNewPasswordConfirm : createPasswordConfirm).trim();

    if (nextPassword.length < 4) {
      setFeedback(undefined, 'A senha adulta precisa ter pelo menos 4 caracteres.');
      return;
    }

    if (nextPassword !== confirmPassword) {
      setFeedback(undefined, 'A confirmacao da senha nao confere.');
      return;
    }

    setLoadingAction('password');
    setFeedback();
    try {
      const adultAccessSettings = await saveAdultAccessPassword({
        currentPassword: changing ? changeCurrentPassword : undefined,
        newPassword: nextPassword,
      });
      setAdultAccessSettings(adultAccessSettings);
      setCreatePassword('');
      setCreatePasswordConfirm('');
      setChangeCurrentPassword('');
      setChangeNewPassword('');
      setChangeNewPasswordConfirm('');
      unlockAdultContent();
      setFeedback(changing ? 'Senha adulta atualizada.' : 'Senha adulta criada.');
    } catch (error: any) {
      setFeedback(undefined, error.message);
    } finally {
      setLoadingAction(null);
    }
  };

  const handleResetAdultFeedback = () => {
    setFeedback(
      'O autenticador TOTP foi removido nesta arquitetura sem VPS. O bloqueio adulto agora usa apenas a senha/PIN salva no Supabase.',
    );
    setAdultAccessSettings({
      enabled: adultAccess.enabled,
      totpEnabled: false,
    });
  };

  const handleLockAdultNow = () => {
    lockAdultContent();
    setFeedback('Conteudo adulto bloqueado novamente.');
  };

  // TV Navigation — placed after all handler declarations to avoid TDZ errors
  const { registerNode } = useTvNavigation({ isActive: false });

  useEffect(() => {
    if (!isVisible) return;
    const unregisterList: (() => void)[] = [];

    unregisterList.push(registerNode({ id: 'settings-close', type: 'button', onEnter: onClose, onBack: onClose }));
    ['general', 'categories', 'adult'].forEach(t => {
      unregisterList.push(registerNode({ id: `tab-${t}`, type: 'button', onFocus: () => setActiveTab(t as SettingsTab), onBack: onClose }));
    });

    if (activeTab === 'general') {
      unregisterList.push(registerNode({ id: 'settings-sync', type: 'button', onEnter: () => void handleRefreshPlaylist(), onBack: onClose }));
      unregisterList.push(registerNode({ id: 'settings-clear-tmdb', type: 'button', onEnter: () => void handleClearMetadataCache(), onBack: onClose }));
      unregisterList.push(registerNode({ id: 'settings-logout', type: 'button', onEnter: () => { if (onLogout) onLogout(); else window.location.reload(); }, onBack: onClose }));
    } else if (activeTab === 'categories') {
      allCategories.forEach(cat => unregisterList.push(registerNode({ id: `cat-item-${cat.id}`, type: 'item', onEnter: () => toggleLocalCategory(cat.id), onBack: onClose })));
      unregisterList.push(registerNode({ id: 'settings-save-cats', type: 'button', onEnter: handleSave, onBack: onClose }));
    } else if (activeTab === 'adult') {
      if (adultAccess.enabled) {
        if (isAdultUnlocked) {
          unregisterList.push(registerNode({ id: 'adult-lock-now', type: 'button', onEnter: handleLockAdultNow, onBack: onClose }));
        } else {
          unregisterList.push(registerNode({ id: 'adult-pin-input', type: 'input', onEnter: () => (document.querySelector('[data-nav-id="adult-pin-input"]') as HTMLInputElement)?.focus(), onBack: onClose }));
          unregisterList.push(registerNode({ id: 'adult-unlock-btn', type: 'button', onEnter: handleAdultUnlock, onBack: onClose }));
        }
      }
      unregisterList.push(registerNode({ id: 'adult-new-pin', type: 'input', onEnter: () => (document.querySelector('[data-nav-id="adult-new-pin"]') as HTMLInputElement)?.focus(), onBack: onClose }));
      unregisterList.push(registerNode({ id: 'adult-save-pin', type: 'button', onEnter: handleAdultPasswordSave, onBack: onClose }));
    }

    return () => unregisterList.forEach(u => u());
  }, [isVisible, activeTab, onClose, registerNode, allCategories, handleRefreshPlaylist, handleSave, toggleLocalCategory, handleAdultUnlock, handleAdultPasswordSave, handleLockAdultNow, onLogout, adultAccess.enabled, isAdultUnlocked]);

  const handleAdultTabOpen = () => {
    setActiveTab('adult');

    if (adultAccess.totpEnabled) {
      handleResetAdultFeedback();
    }
  };

  useEffect(() => {
    if (activeTab === 'adult' && adultAccess.totpEnabled) {
      handleResetAdultFeedback();
    }
  }, [activeTab, adultAccess.enabled, adultAccess.totpEnabled]);

  const renderAdultRecoveryNotice = () => {
    if (!adultAccess.totpEnabled) {
      return null;
    }

    return (
      <View style={styles.warningBox}>
        <Text style={styles.noticeText}>
          O modo TOTP do legado nao e mais usado. Salve uma nova senha adulta para limpar essa configuracao no Supabase.
        </Text>
      </View>
    );
  };

  const renderAdultProtectionCard = () => (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>
        {adultLocked ? 'Conteudo adulto bloqueado' : 'Conteudo adulto liberado nesta sessao'}
      </Text>
      <Text style={styles.cardText}>
        {adultAccess.enabled
          ? adultLocked
            ? 'As categorias adultas ficam ocultas ate o desbloqueio manual.'
            : 'O desbloqueio vale apenas para esta sessao do aplicativo.'
          : 'Crie uma senha ou PIN para que o proprio usuario controle o acesso.'}
      </Text>
      {adultAccess.enabled ? (
        isAdultUnlocked ? (
          <TouchableHighlight
            onPress={handleLockAdultNow}
            underlayColor="rgba(239,68,68,0.12)"
            style={styles.secondaryButton}
          >
            <View style={styles.buttonInner}>
              <Text style={[styles.buttonText, { color: '#f87171' }]}>Bloquear agora</Text>
            </View>
          </TouchableHighlight>
        ) : (
          <>
            <TextInput
              style={styles.input}
              placeholder="Senha do conteudo adulto"
              placeholderTextColor="rgba(255,255,255,0.25)"
              secureTextEntry
              value={unlockPassword}
              onChangeText={setUnlockPassword}
              data-nav-id="adult-pin-input"
            />
            <TouchableHighlight
              onPress={handleAdultUnlock}
              underlayColor="#b91c1c"
              style={[styles.primaryButton, loadingAction === 'unlock' && styles.disabled]}
              disabled={loadingAction === 'unlock'}
              data-nav-id="adult-unlock-btn"
            >
              <View style={styles.buttonInner}>
                <Text style={styles.buttonText}>Desbloquear</Text>
              </View>
            </TouchableHighlight>
          </>
        )
      ) : null}
    </View>
  );

  const renderAdultPasswordCard = () => (
    <View style={styles.card}>
      <View style={styles.sectionTitleRow}>
        <KeyRound size={16} color="#E50914" />
        <Text style={styles.sectionTitle}>{adultAccess.enabled ? 'Trocar senha adulta' : 'Criar senha adulta'}</Text>
      </View>
      {adultAccess.enabled ? (
        <>
          <TextInput style={styles.input} placeholder="Senha atual" placeholderTextColor="rgba(255,255,255,0.25)" secureTextEntry value={changeCurrentPassword} onChangeText={setChangeCurrentPassword} />
          <TextInput style={styles.input} placeholder="Nova senha ou PIN" placeholderTextColor="rgba(255,255,255,0.25)" secureTextEntry value={changeNewPassword} onChangeText={setChangeNewPassword} />
          <TextInput style={styles.input} placeholder="Confirmar nova senha" placeholderTextColor="rgba(255,255,255,0.25)" secureTextEntry value={changeNewPasswordConfirm} onChangeText={setChangeNewPasswordConfirm} />
        </>
      ) : (
        <>
          <TextInput style={styles.input} placeholder="Nova senha ou PIN" placeholderTextColor="rgba(255,255,255,0.25)" secureTextEntry value={createPassword} onChangeText={setCreatePassword} />
          <TextInput style={styles.input} placeholder="Confirmar senha" placeholderTextColor="rgba(255,255,255,0.25)" secureTextEntry value={createPasswordConfirm} onChangeText={setCreatePasswordConfirm} />
        </>
      )}
      <TouchableHighlight
        onPress={handleAdultPasswordSave}
        underlayColor="#b91c1c"
        style={[styles.primaryButton, loadingAction === 'password' && styles.disabled]}
        disabled={loadingAction === 'password'}
        data-nav-id="adult-save-pin"
      >
        <View style={styles.buttonInner}>
          <Text style={styles.buttonText}>{adultAccess.enabled ? 'Atualizar senha' : 'Salvar senha'}</Text>
        </View>
      </TouchableHighlight>
    </View>
  );

  const renderAdultArchitectureCard = () => (
    <View style={styles.card}>
      <View style={styles.sectionTitleRow}>
        <Shield size={16} color="#E50914" />
        <Text style={styles.sectionTitle}>Arquitetura final do bloqueio adulto</Text>
      </View>
      <Text style={styles.cardText}>
        O desbloqueio agora usa somente senha ou PIN salvo no Supabase. Isso remove a dependencia do backend Express e do fluxo TOTP legado.
      </Text>
    </View>
  );

  const renderAdultSection = () => (
    <ScrollView showsVerticalScrollIndicator={false}>
      <Text style={styles.label}>Controle adulto</Text>
      <Text style={styles.hint}>
        {adultCategoryCount > 0
          ? `${adultCategoryCount} categorias adultas detectadas.`
          : 'Nenhuma categoria adulta detectada nesta lista, mas a protecao pode ser preparada.'}
      </Text>

      {renderAdultRecoveryNotice()}
      {renderAdultProtectionCard()}

      {statusMessage ? <View style={styles.successBox}><Text style={styles.noticeText}>{statusMessage}</Text></View> : null}
      {errorMessage ? <View style={styles.errorBox}><Text style={styles.noticeText}>{errorMessage}</Text></View> : null}

      {renderAdultPasswordCard()}
      {renderAdultArchitectureCard()}
    </ScrollView>
  );

  const handleAdultTabPress = () => {
    handleAdultTabOpen();
  };

  const renderTabButton = (tab: SettingsTab, label: string, icon: React.ReactNode) => (
      <TouchableHighlight
        onPress={() => (tab === 'adult' ? handleAdultTabPress() : setActiveTab(tab))}
        underlayColor="rgba(255,255,255,0.05)"
        style={[styles.tab, activeTab === tab && styles.activeTab]}
        data-nav-id={`tab-${tab}`}
      >
      <View style={styles.tabInner}>
        <span>{icon}</span>
        <Text style={[styles.tabText, activeTab === tab && styles.activeTabText]}>{label}</Text>
      </View>
    </TouchableHighlight>
  );

  return (
    <Modal visible={isVisible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.modal}>
          <View style={styles.header}>
            <View style={styles.headerTitle}>
              <span style={{ marginRight: 12 }}>
                <Link size={24} color="#E50914" />
              </span>
              <Text style={styles.title}>Configuracoes</Text>
            </View>
            <TouchableHighlight 
              onPress={onClose} 
              underlayColor="rgba(255,255,255,0.1)" 
              style={styles.closeButton}
              data-nav-id="settings-close"
            >
              <View>
                <span>
                  <X size={22} color="white" />
                </span>
              </View>
            </TouchableHighlight>
          </View>

          <View style={styles.tabs}>
            {renderTabButton('general', 'Sessao', <Link size={18} color={activeTab === 'general' ? '#E50914' : 'rgba(255,255,255,0.5)'} />)}
            {renderTabButton('categories', 'Categorias', <List size={18} color={activeTab === 'categories' ? '#E50914' : 'rgba(255,255,255,0.5)'} />)}
            {renderTabButton('adult', 'Adulto', <Shield size={18} color={activeTab === 'adult' ? '#E50914' : 'rgba(255,255,255,0.5)'} />)}
          </View>

          <View style={styles.content}>
            {activeTab === 'general' ? (
              <ScrollView showsVerticalScrollIndicator={false}>
                <Text style={styles.label}>Aplicativo</Text>
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>Xandeflix Premium</Text>
                  <Text style={styles.cardText}>Sessao via Supabase, sincronizacao da playlist e bloqueio adulto por usuario.</Text>
                  <TouchableHighlight
                    onPress={handleRefreshPlaylist}
                    underlayColor="rgba(255,255,255,0.08)"
                    style={[styles.secondaryButton, { marginTop: 8, width: '100%', borderColor: 'rgba(255,255,255,0.15)' }]}
                    disabled={loadingAction === 'refresh'}
                    data-nav-id="settings-sync"
                  >
                    <View style={styles.buttonInner}>
                      <span style={{ marginRight: 10 }}>
                        <RefreshCw size={18} color="#fff" style={loadingAction === 'refresh' ? { animation: 'spin 2s linear infinite' } : {}} />
                      </span>
                      <Text style={styles.buttonText}>
                        {loadingAction === 'refresh' ? 'Sincronizando...' : 'Sincronizar Lista'}
                      </Text>
                    </View>
                  </TouchableHighlight>

                  <TouchableHighlight
                    onPress={handleClearMetadataCache}
                    underlayColor="rgba(255,255,255,0.08)"
                    style={[styles.secondaryButton, { marginTop: 12, width: '100%', borderColor: 'rgba(255,255,255,0.15)' }]}
                    disabled={loadingAction === 'clear-tmdb'}
                    data-nav-id="settings-clear-tmdb"
                  >
                    <View style={styles.buttonInner}>
                      <span style={{ marginRight: 10 }}>
                        <RotateCcw size={18} color="#aaa" />
                      </span>
                      <Text style={styles.buttonText}>
                        {loadingAction === 'clear-tmdb' ? 'Limpando...' : 'Revalidar Capas e Metadados'}
                      </Text>
                    </View>
                  </TouchableHighlight>
                </View>

                {statusMessage && activeTab === 'general' ? <View style={styles.successBox}><Text style={styles.noticeText}>{statusMessage}</Text></View> : null}
                {errorMessage && activeTab === 'general' ? <View style={styles.errorBox}><Text style={styles.noticeText}>{errorMessage}</Text></View> : null}

                <TouchableHighlight
                  onPress={() => {
                    if (onLogout) onLogout();
                    else {
                      window.location.reload();
                    }
                  }}
                  underlayColor="rgba(239,68,68,0.1)"
                  style={[styles.secondaryButton, { marginTop: 24 }]}
                  data-nav-id="settings-logout"
                >
                  <View style={styles.buttonInner}>
                    <span style={{ marginRight: 8 }}>
                      <RotateCcw size={18} color="#ef4444" />
                    </span>
                    <Text style={[styles.buttonText, { color: '#ef4444' }]}>Terminar sessao</Text>
                  </View>
                </TouchableHighlight>
              </ScrollView>
            ) : null}

            {activeTab === 'categories' ? (
              <View style={{ flex: 1 }}>
                <Text style={styles.label}>Categorias visiveis</Text>
                <ScrollView style={styles.listBox} showsVerticalScrollIndicator={false}>
                  {allCategories.map((category) => {
                    const isHidden = localHiddenIds.includes(category.id);
                    return (
                      <TouchableHighlight
                        key={category.id}
                        onPress={() => toggleLocalCategory(category.id)}
                        underlayColor="rgba(255,255,255,0.05)"
                        style={styles.listItem}
                        data-nav-id={`cat-item-${category.id}`}
                      >
                        <View style={styles.listItemInner}>
                          <View style={[styles.checkbox, !isHidden && styles.checkboxChecked]}>
                            {!isHidden ? <span><Check size={14} color="white" /></span> : null}
                          </View>
                          <View style={{ flex: 1 }}>
                            <Text style={[styles.listTitle, isHidden && styles.listTitleHidden]}>{category.title}</Text>
                            <Text style={styles.listMeta}>{category.items.length} itens</Text>
                          </View>
                        </View>
                      </TouchableHighlight>
                    );
                  })}
                </ScrollView>
                <TouchableHighlight 
                  onPress={handleSave} 
                  underlayColor="#b91c1c" 
                  style={styles.primaryButton}
                  data-nav-id="settings-save-cats"
                >
                  <View style={styles.buttonInner}>
                    <span style={{ marginRight: 8 }}>
                      <Save size={18} color="white" />
                    </span>
                    <Text style={styles.buttonText}>Salvar categorias</Text>
                  </View>
                </TouchableHighlight>
              </View>
            ) : null}

            {activeTab === 'adult' ? renderAdultSection() : null}
          </View>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.85)', justifyContent: 'center', alignItems: 'center' },
  modal: { width: 760, height: 680, backgroundColor: '#161616', borderRadius: 16, borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)', overflow: 'hidden' } as any,
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 24, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.05)' },
  headerTitle: { flexDirection: 'row', alignItems: 'center' },
  title: { color: 'white', fontSize: 24, fontWeight: '900', fontFamily: 'Outfit' },
  closeButton: { padding: 8, borderRadius: 50 },
  tabs: { flexDirection: 'row', paddingHorizontal: 24, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.05)' },
  tab: { paddingVertical: 16, paddingHorizontal: 20, borderBottomWidth: 2, borderBottomColor: 'transparent' },
  activeTab: { borderBottomColor: '#E50914' },
  tabInner: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  tabText: { color: 'rgba(255,255,255,0.5)', fontWeight: 'bold', fontSize: 14 },
  activeTabText: { color: 'white' },
  content: { flex: 1, padding: 24 },
  label: { color: 'rgba(255,255,255,0.7)', fontSize: 14, fontWeight: 'bold', marginBottom: 12, textTransform: 'uppercase', letterSpacing: 1 },
  hint: { color: 'rgba(255,255,255,0.45)', fontSize: 13, lineHeight: 20, marginBottom: 18 },
  card: { backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: 14, borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)', padding: 16, marginBottom: 16 },
  cardTitle: { color: 'white', fontSize: 16, fontWeight: '800', marginBottom: 8 },
  cardText: { color: 'rgba(255,255,255,0.62)', fontSize: 14, lineHeight: 20, marginBottom: 12 },
  sectionTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  sectionTitle: { color: 'white', fontSize: 15, fontWeight: '800' },
  input: { backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)', borderRadius: 12, padding: 14, color: 'white', fontSize: 15, marginBottom: 12 },
  readonlyInput: { color: 'rgba(255,255,255,0.68)' },
  primaryButton: { alignSelf: 'flex-start', backgroundColor: '#E50914', paddingHorizontal: 18, paddingVertical: 12, borderRadius: 12, marginTop: 4 },
  secondaryButton: { alignSelf: 'flex-start', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)', backgroundColor: 'rgba(255,255,255,0.03)', paddingHorizontal: 18, paddingVertical: 12, borderRadius: 12, marginTop: 4 },
  buttonInner: { flexDirection: 'row', alignItems: 'center' },
  buttonText: { color: 'white', fontWeight: 'bold', fontSize: 15 },
  disabled: { opacity: 0.6 },
  successBox: { backgroundColor: 'rgba(34,197,94,0.08)', borderWidth: 1, borderColor: 'rgba(34,197,94,0.22)', borderRadius: 12, padding: 14, marginBottom: 16 },
  errorBox: { backgroundColor: 'rgba(239,68,68,0.08)', borderWidth: 1, borderColor: 'rgba(239,68,68,0.22)', borderRadius: 12, padding: 14, marginBottom: 16 },
  warningBox: { backgroundColor: 'rgba(245,158,11,0.08)', borderWidth: 1, borderColor: 'rgba(245,158,11,0.24)', borderRadius: 12, padding: 14, marginBottom: 16 },
  noticeText: { color: 'rgba(255,255,255,0.8)', fontSize: 13, lineHeight: 18 },
  listBox: { flex: 1, backgroundColor: 'rgba(255,255,255,0.02)', borderRadius: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.05)', marginBottom: 18 },
  listItem: { padding: 16, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.05)' },
  listItemInner: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  checkbox: { width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: 'rgba(255,255,255,0.2)', alignItems: 'center', justifyContent: 'center' },
  checkboxChecked: { backgroundColor: '#E50914', borderColor: '#E50914' },
  listTitle: { color: 'white', fontSize: 16, fontWeight: 'bold' },
  listTitleHidden: { color: 'rgba(255,255,255,0.3)', textDecorationLine: 'line-through' },
  listMeta: { color: 'rgba(255,255,255,0.4)', fontSize: 12, marginTop: 2 },
});
