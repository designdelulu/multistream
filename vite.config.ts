import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    open: true,
    // youtube-resolve.php needs an actual PHP runtime — Vite only serves it
    // as static text otherwise. Run `php -S localhost:8787 -t public/api`
    // locally to exercise the YouTube channel/handle resolve path in dev;
    // harmless (just a connection-refused -> resolver_unreachable) if that
    // server isn't running.
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  preview: {
    port: 5173,
  },
  appType: 'spa',
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/testSetup.ts'],
  },
});
