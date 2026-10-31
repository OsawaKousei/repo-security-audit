import { Hono } from 'hono'

const app = new Hono()

app.get('/api/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'repo-sentinel-api',
  })
})

export default app