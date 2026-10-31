import { serve } from '@hono/node-server'
import app from './app.js'

serve(
  {
    fetch: app.fetch,
    hostname: '0.0.0.0',
    port: 3000,
  },
  (info) => {
    console.log(`API listening on port ${info.port}`)
  },
)