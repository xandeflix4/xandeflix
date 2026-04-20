import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableHighlight, TextInput, ImageBackground } from 'react-native';
import { motion } from 'motion/react';
import { Link, ArrowRight } from 'lucide-react';
import { useResponsiveLayout } from '../hooks/useResponsiveLayout';

interface SetupScreenProps {
  onComplete: (url: string) => void;
}

export const SetupScreen: React.FC<SetupScreenProps> = ({ onComplete }) => {
  const layout = useResponsiveLayout();
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const isTvProfile = layout.isTvProfile;

  const handleStart = () => {
    if (!url.trim()) {
      setError('Por favor, insira uma URL valida.');
      return;
    }
    if (!url.startsWith('http')) {
      setError('A URL deve comecar com http:// ou https://');
      return;
    }
    onComplete(url.trim());
  };

  const fillExample = () => {
    setUrl('https://seu-provedor.com/get.php?username=SEU_USUARIO&password=SUA_SENHA&type=m3u_plus&output=mpegts');
    setError('');
  };

  return (
    <View style={styles.container}>
      <ImageBackground
        source={{ uri: 'https://picsum.photos/seed/iptv/1920/1080?blur=10' }}
        style={styles.background}
        resizeMode="cover"
      >
        <View style={styles.overlay}>
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8 }}
            className="w-full max-w-2xl"
            style={{
              paddingLeft: isTvProfile ? 18 : 32,
              paddingRight: isTvProfile ? 18 : 32,
              maxWidth: isTvProfile ? 720 : undefined,
            }}
          >
            <View style={[styles.logoContainer, isTvProfile && styles.logoContainerTv]}>
              <Text style={[styles.logo, isTvProfile && styles.logoTv]}>XANDEFLIX</Text>
              <Text style={[styles.subtitle, isTvProfile && styles.subtitleTv]}>Sua experiencia definitiva de IPTV</Text>
            </View>

            {/* @ts-expect-error: className works on React Native Web but TypeScript complains */}
            <View style={[styles.card, isTvProfile && styles.cardTv]} className="backdrop-blur-xl">
              <Text style={[styles.cardTitle, isTvProfile && styles.cardTitleTv]}>Configuracao Inicial</Text>
              <Text style={[styles.cardDescription, isTvProfile && styles.cardDescriptionTv]}>
                Para comecar, insira a URL da sua lista M3U ou M3U8 fornecida pelo seu provedor.
              </Text>

              <View
                style={[styles.inputWrapper, isTvProfile && styles.inputWrapperTv]}
                {...({ className: "flex flex-row items-center bg-black/30 rounded-xl border border-white/10 px-4 mb-3" } as any)}
              >
                <span style={{ marginRight: 12 }}><Link size={20} color="rgba(255,255,255,0.4)" /></span>
                <TextInput
                  style={[styles.input, isTvProfile && styles.inputTv]}
                  // @ts-expect-error className e suportado no runtime web via react-native-web
                  className="outline-none"
                  placeholder="http://seu-provedor.com/lista.m3u"
                  placeholderTextColor="rgba(255,255,255,0.3)"
                  value={url}
                  onChangeText={(text) => {
                    setUrl(text);
                    setError('');
                  }}
                  autoFocus
                />
              </View>

              {error ? <Text style={styles.errorText}>{error}</Text> : null}

              <View style={[styles.buttonGroup, isTvProfile && styles.buttonGroupTv]}>
                <TouchableHighlight onPress={handleStart} underlayColor="#b91c1c" style={[styles.primaryButton, isTvProfile && styles.buttonTv]}>
                  <View style={styles.buttonInner}>
                    <Text style={[styles.buttonText, isTvProfile && styles.buttonTextTv]}>Carregar Lista</Text>
                    <span style={{ marginLeft: 8 }}><ArrowRight size={20} color="white" /></span>
                  </View>
                </TouchableHighlight>

                <TouchableHighlight onPress={fillExample} underlayColor="rgba(255,255,255,0.1)" style={[styles.secondaryButton, isTvProfile && styles.buttonTv]}>
                  <Text style={[styles.secondaryButtonText, isTvProfile && styles.secondaryButtonTextTv]}>Usar Exemplo</Text>
                </TouchableHighlight>
              </View>
            </View>

            <Text style={[styles.footer, isTvProfile && styles.footerTv]}>
              Suas configuracoes serao salvas localmente para o proximo acesso.
            </Text>
          </motion.div>
        </View>
      </ImageBackground>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#050505',
  },
  background: {
    flex: 1,
  },
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  logoContainer: {
    alignItems: 'center',
    marginBottom: 48,
  },
  logoContainerTv: {
    marginBottom: 26,
  },
  logo: {
    fontSize: 64,
    fontWeight: '900',
    color: '#E50914',
    fontFamily: 'Outfit',
    letterSpacing: -2,
    fontStyle: 'italic',
  },
  logoTv: {
    fontSize: 50,
  },
  subtitle: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 18,
    marginTop: -8,
    letterSpacing: 1,
  },
  subtitleTv: {
    fontSize: 14,
    marginTop: -4,
  },
  card: {
    backgroundColor: 'rgba(26, 26, 26, 0.8)',
    borderRadius: 24,
    padding: 40,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  cardTv: {
    borderRadius: 20,
    padding: 28,
  },
  cardTitle: {
    color: 'white',
    fontSize: 28,
    fontWeight: 'bold',
    marginBottom: 12,
  },
  cardTitleTv: {
    fontSize: 24,
  },
  cardDescription: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 16,
    lineHeight: 24,
    marginBottom: 32,
  },
  cardDescriptionTv: {
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 22,
  },
  inputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.3)',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    paddingHorizontal: 16,
    marginBottom: 12,
  },
  inputWrapperTv: {
    marginBottom: 10,
  },
  input: {
    flex: 1,
    height: 56,
    color: 'white',
    fontSize: 16,
  },
  inputTv: {
    height: 48,
    fontSize: 14,
  },
  errorText: {
    color: '#ef4444',
    fontSize: 14,
    marginBottom: 16,
  },
  buttonGroup: {
    flexDirection: 'row',
    gap: 16,
  },
  buttonGroupTv: {
    gap: 12,
  },
  primaryButton: {
    flex: 2,
    backgroundColor: '#E50914',
    height: 56,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  secondaryButton: {
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.05)',
    height: 56,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  buttonTv: {
    height: 48,
  },
  buttonInner: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  buttonText: {
    color: 'white',
    fontSize: 18,
    fontWeight: 'bold',
  },
  buttonTextTv: {
    fontSize: 15,
  },
  secondaryButtonText: {
    color: 'white',
    fontSize: 14,
    fontWeight: '600',
  },
  secondaryButtonTextTv: {
    fontSize: 13,
  },
  footer: {
    color: 'rgba(255,255,255,0.3)',
    fontSize: 12,
    textAlign: 'center',
    marginTop: 24,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  footerTv: {
    marginTop: 18,
    fontSize: 11,
  },
});
