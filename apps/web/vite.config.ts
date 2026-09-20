import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const buildRevision = process.env.VITE_BUILD_REVISION ?? process.env.GITHUB_SHA ?? 'local';
const authConfigUrl = process.env.VITE_AUTH_CONFIG_URL;

function developmentAuthConfig(): Plugin {
  return {
    name: 'development-auth-config',
    configureServer(server) {
      if (!authConfigUrl) {
        return;
      }
      server.middlewares.use('/auth-config.json', async (_request, response, next) => {
        try {
          const upstream = await fetch(authConfigUrl);
          if (!upstream.ok) {
            next();
            return;
          }
          const config = (await upstream.json()) as Record<string, unknown>;
          const localOrigin = 'http://localhost:5173/';
          config.redirectUri = localOrigin;
          config.logoutUri = localOrigin;
          response.statusCode = 200;
          response.setHeader('Content-Type', 'application/json');
          response.setHeader('Cache-Control', 'no-store');
          response.end(JSON.stringify(config));
        } catch {
          next();
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), developmentAuthConfig()],
  server: {
    port: 5173,
    strictPort: true,
  },
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
