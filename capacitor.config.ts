import 'dotenv/config';
import type { CapacitorConfig } from '@capacitor/cli';

const devServerUrl = String(process.env.CAPACITOR_DEV_SERVER_URL || '').trim().replace(/\/+$/, '');
const usesDevServer = devServerUrl.length > 0;
const androidScheme = 'http';

const config: CapacitorConfig = {
  appId: 'com.xandeflix.app',
  appName: 'Xandeflix',
  webDir: 'dist',
  backgroundColor: '#050505',
  server: {
    // Android TV playlists and artwork frequently include HTTP-only hosts.
    // Keeping the WebView origin in HTTP avoids mixed-content blocking.
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
