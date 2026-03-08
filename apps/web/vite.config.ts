import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Web 번들 설정:
// - React/Tailwind 기반 UI를 Vite로 빌드한다.
// - 자주 바뀌지 않는 라이브러리는 chunk를 분리해 캐시 효율을 유지한다.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          motion: ['motion'],
          supabase: ['@supabase/supabase-js'],
          radix: ['@radix-ui/react-label', '@radix-ui/react-select', '@radix-ui/react-slot', '@radix-ui/react-tabs'],
        },
      },
    },
  },
  server: {
    port: 5173,
  },
});
