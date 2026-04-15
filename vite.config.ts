import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import legacy from '@vitejs/plugin-legacy';
import fs from 'fs';
import path from 'path';
import { defineConfig } from 'vite';
function __dirname_fallback() { return '.'; }
const __dirname = path.resolve();

const packageJson = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'),
) as { version?: string };
const buildTimestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 12);
const appVersion = String(packageJson.version || '0.0.0');

export default defineConfig({
  plugins: [
    react(), 
    tailwindcss(),
    legacy({
      targets: ['defaults', 'not IE 11', 'Android >= 5.0'],
      polyfills: true,
      additionalLegacyPolyfills: ['regenerator-runtime/runtime'],
    }),
  ],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    __APP_BUILD_ID__: JSON.stringify(buildTimestamp),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
      'react-native': path.resolve(__dirname, 'src/lib/react-native-shim.tsx'),
    },
  },
  build: {
    target: 'es2015',
    cssTarget: 'chrome60',
    minify: 'terser',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) {
            return undefined;
          }

          if (id.includes('@supabase/supabase-js')) {
            return 'supabase';
          }

          if (id.includes('react-native-web') || id.includes('/react-native/') || id.includes('\\react-native\\')) {
            return 'native-web';
          }

          if (id.includes('bcryptjs') || id.includes('lodash')) {
            return 'admin-tools';
          }

          if (id.includes('motion') || id.includes('lucide-react')) {
            return 'ui-motion';
          }

          return 'vendor';
        },
      },
    },
  },
  server: {
    host: '0.0.0.0',
    // HMR is disabled in AI Studio via DISABLE_HMR env var.
    // Do not modify; file watching is disabled to prevent flickering during agent edits.
    hmr: process.env.DISABLE_HMR !== 'true',
  },
});
