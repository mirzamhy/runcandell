import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, resolve, sep } from 'node:path'
import { defineConfig, type Plugin } from 'vite'

// Dev only: serve ../data/build at /data. In production the data lives on a CDN (VITE_DATA_URL).
const DATA_DIR = resolve(import.meta.dirname, '../data/build')
const TYPES: Record<string, string> = {
  '.json': 'application/json',
  '.parquet': 'application/octet-stream',
}

function serveData(): Plugin {
  return {
    name: 'serve-data',
    configureServer(server) {
      server.middlewares.use('/data', (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? '/').split('?')[0])
        const file = resolve(DATA_DIR, '.' + rel)
        if (!file.startsWith(DATA_DIR + sep) || !existsSync(file) || !statSync(file).isFile()) return next()
        res.setHeader('Content-Type', TYPES[extname(file)] ?? 'application/octet-stream')
        res.setHeader('Cache-Control', 'no-cache')
        createReadStream(file).pipe(res)
      })
    },
  }
}

export default defineConfig({
  plugins: [serveData()],
  server: { port: 5200, strictPort: true },
})
