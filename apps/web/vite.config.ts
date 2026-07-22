import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Web 번들 설정:
// - React/Tailwind 기반 UI를 Vite로 빌드한다.
// - 자주 바뀌지 않는 공용 런타임은 chunk를 분리해 캐시 효율을 유지한다.
// - 로그인 화면에서만 쓰는 Radix UI는 라우트 chunk에 남겨 공개 화면이 미리 받지 않게 한다.
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
          'react-vendor': ['react', 'react-dom', 'react-dom/client', 'react-router-dom'],
          supabase: ['@supabase/supabase-js'],
        },
      },
    },
  },
  server: {
    port: 5173,
  },
});
