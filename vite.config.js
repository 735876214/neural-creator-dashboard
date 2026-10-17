import {defineConfig} from 'vite';

// base 用相对路径，构建产物可以直接部署在任意子路径。
export default defineConfig({
  base: './',
  server: {
    // 开发时把 /api 转给本机的 note-api（npm run api），
    // 这样前端代码里的 fetch('/api/...') 不用改，和部署时保持同源。
    // 没起后端也不影响：boot.js 会回退到内置示例数据。
    proxy: {'/api': {target: process.env.NOTE_API || 'http://127.0.0.1:8787', changeOrigin: true}}
  }
});
