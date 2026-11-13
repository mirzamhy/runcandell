import { serve } from '@hono/node-server'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createApp } from './app.ts'
import { openDb } from './db.ts'
import { ParquetMarket } from './market.ts'

const dbPath = resolve(process.env.RC_DB ?? resolve(import.meta.dirname, '../../data/server/runcandell.db'))
mkdirSync(dirname(dbPath), { recursive: true })
const db = openDb(dbPath)
const dataDir = resolve(process.env.RC_DATA ?? resolve(import.meta.dirname, '../../data/build'))
const app = createApp(db, { secureCookie: process.env.NODE_ENV === 'production', market: new ParquetMarket(dataDir) })
const port = Number(process.env.PORT ?? 5201)

serve({ fetch: app.fetch, port, hostname: process.env.HOST ?? '127.0.0.1' }, () => {
  console.log(`runcandell API http://localhost:${port} (db ${dbPath})`)
})
