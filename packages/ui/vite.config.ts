import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Relative base so the same bundle works from file:// in Electron and from
  // the Android asset loader.
  base: './',
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
  server: { port: 5273, strictPort: true },
});
