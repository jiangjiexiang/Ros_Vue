import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
    plugins: [vue()],
    server: {
        host: '0.0.0.0',
        port: Number(process.env.VITE_PORT || 5173),
        strictPort: true,
        watch: {
            ignored: ['**/.git/**', '**/.chrome-*/**', '**/maps/**', '**/data/**', '**/.backups/**']
        },
        proxy: {
            '/api': {
                target: process.env.BACKEND_URL || 'http://127.0.0.1:3000',
                changeOrigin: true
            }
        }
    }
})
