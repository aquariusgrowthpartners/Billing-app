import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API = `http://127.0.0.1:${process.env.API_PORT ?? 4000}`;

// Dev is mounted at /billing so Tailscale Serve can expose it with
// --set-path=/billing without clobbering "/". Production builds stay at "/".
export default defineConfig(({ command }) => {
  const base = process.env.BASE_PATH ?? (command === 'serve' ? '/billing/' : '/');
  const basePath = base.endsWith('/') ? base : `${base}/`;
  const baseNoSlash = basePath.replace(/\/$/, '');

  const proxy = {
    '/api': { target: API, changeOrigin: false },
  };
  // Requests under the base prefix (e.g. /billing/api) must be rewritten back
  // to /api before they reach Express.
  if (basePath !== '/') {
    proxy[`${basePath}api`] = {
      target: API,
      changeOrigin: false,
      rewrite: (p) => p.replace(baseNoSlash, ''),
    };
  }

  // Vite returns 404 for "/billing" (no trailing slash); normalize it.
  const redirectBase = {
    name: 'redirect-base-without-slash',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const [pathname, query] = (req.url ?? '').split('?');
        if (pathname === baseNoSlash) {
          res.statusCode = 302;
          res.setHeader('Location', `${basePath}${query ? `?${query}` : ''}`);
          res.end();
          return;
        }
        next();
      });
    },
  };

  return {
    root: __dirname,
    base,
    plugins: [redirectBase, react()],
    server: {
      host: '127.0.0.1',
      port: Number(process.env.WEB_PORT ?? 5173),
      strictPort: true,
      open: false,
      allowedHosts: ['.ts.net', 'jamess-macbook-pro.taild02b07.ts.net', 'localhost', '127.0.0.1'],
      proxy,
    },
    build: {
      outDir: path.join(__dirname, 'dist'),
      emptyOutDir: true,
    },
  };
});
