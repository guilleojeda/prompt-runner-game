import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const buildRevision = process.env.VITE_BUILD_REVISION ?? process.env.GITHUB_SHA ?? 'local';

if (!/^[A-Za-z0-9._-]+$/.test(buildRevision)) {
  throw new Error(
    'VITE_BUILD_REVISION must contain only letters, numbers, dots, underscores, or hyphens.',
  );
}

function buildRevisionHtml(): Plugin {
  return {
    name: 'monitoring-build-revision',
    transformIndexHtml(html) {
      return html.replaceAll('%BUILD_REVISION%', buildRevision);
    },
  };
}

export default defineConfig({
  plugins: [react(), buildRevisionHtml()],
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
