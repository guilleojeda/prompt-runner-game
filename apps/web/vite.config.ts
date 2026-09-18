import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const buildRevision = process.env.VITE_BUILD_REVISION ?? process.env.GITHUB_SHA ?? 'local';

export default defineConfig({
  plugins: [react()],
  define: {
    'import.meta.env.VITE_BUILD_REVISION': JSON.stringify(buildRevision),
  },
  build: {
    assetsDir: 'assets',
    manifest: true,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
