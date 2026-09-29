import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ command }) => ({
  plugins: [react()],
  // The built bundle uses a relative base so it works wherever a host serves
  // it; both shells serve it at https://play.dragonfable.com/__dfh/. The dev
  // server uses that same path so the desktop shell can proxy it in place.
  base: command === 'build' ? './' : '/__dfh/',
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
  server: {
    port: 5273,
    strictPort: true,
    // The page runs on the game's origin in Electron, so point hot reload
    // straight at the dev server instead of at that origin.
    hmr: { protocol: 'ws', host: 'localhost', port: 5273 },
  },
}));
