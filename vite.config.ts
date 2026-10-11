import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig(() => {
  return {
    root: __dirname,
    base: '/',
    plugins: [
      {
        name: 'resolve-toni-entry',
        resolveId(source) {
          if (
            source === '/src/main.tsx' ||
            source === './src/main.tsx' ||
            source === 'src/main.tsx'
          ) {
            const srcEntry = path.resolve(__dirname, 'src/main.tsx');
            if (fs.existsSync(srcEntry)) return srcEntry;
            const rootEntry = path.resolve(__dirname, 'main.tsx');
            if (fs.existsSync(rootEntry)) return rootEntry;
          }
          return null;
        },
      },
      react(),
      tailwindcss(),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
        '/src': path.resolve(__dirname, 'src'),
      },
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
