import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import fs from 'node:fs';

// 自定义插件：读取 public/models 目录，返回文件列表
function modelsApiPlugin() {
  return {
    name: 'models-api',
    configureServer(server) {
      server.middlewares.use('/api/models', (req, res) => {
        const modelsDir = resolve(import.meta.dirname, 'public/models');
        try {
          if (!fs.existsSync(modelsDir)) {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify([]));
            return;
          }
          const files = fs.readdirSync(modelsDir)
            .filter(f => f.endsWith('.glb') || f.endsWith('.gltf'))
            .map(f => `/models/${f}`);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(files));
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: e.message }));
        }
      });
    }
  };
}

export default defineConfig({
  root: resolve(import.meta.dirname),
  publicDir: 'public',
  plugins: [modelsApiPlugin()],
  build: { outDir: '../dist', emptyOutDir: true },
  server: { port: 5173, strictPort: true },
});
