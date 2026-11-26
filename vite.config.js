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
                changeOrigin: true,
                configure(proxy) {
                    proxy.on('proxyReq', (proxyReq) => {
                        if (process.env.API_TOKEN) {
                            proxyReq.setHeader('Authorization', `Bearer ${process.env.API_TOKEN}`)
                        }
                    })
                }
            },
            '/ws/doglink-indoor': {
                target: 'ws://127.0.0.1:8770',
                ws: true,
                changeOrigin: true,
                rewrite: () => '/'
            },
            '/ws/doglink-warehouse': {
                target: 'ws://127.0.0.1:8771',
                ws: true,
                changeOrigin: true,
                rewrite: () => '/'
            },
            '/ws/doglink-outdoor': {
                target: 'ws://127.0.0.1:8772',
                ws: true,
                changeOrigin: true,
                rewrite: () => '/'
            },
            '/ws/doglink': {
                target: 'ws://127.0.0.1:8768',
                ws: true,
                changeOrigin: true,
                rewrite: () => '/'
            },
            '/ws/foxglove': {
                target: 'ws://127.0.0.1:8765',
                ws: true,
                changeOrigin: true,
                rewrite: () => '/'
            }
        }
    }
})
