import 'dotenv/config';
import type { CapacitorConfig } from '@capacitor/cli';

const devServerUrl = String(process.env.CAPACITOR_DEV_SERVER_URL || '').trim().replace(/\/+$/, '');
const usesDevServer = devServerUrl.length > 0;
const androidScheme = usesDevServer && !devServerUrl.startsWith('https://') ? 'http' : 'https';

const config: CapacitorConfig = {
  appId: 'com.xandeflix.app',
  appName: 'Xandeflix',
  webDir: 'dist',
  backgroundColor: '#050505',
  server: {
    // Keep the app on a native Android scheme in production and allow cleartext
    // streams when the provider still exposes HTTP endpoints.
    androidScheme,
    cleartext: true,
    ...(usesDevServer
      ? {
          // Development only: loads the app from a machine in the local network.
          url: devServerUrl,
        }
      : {}),
  },
  plugins: {
    CapacitorHttp: {
      enabled: true,
    },
  },
};

export default config;
