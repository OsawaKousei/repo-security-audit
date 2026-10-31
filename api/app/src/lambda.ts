import { Hono } from 'hono'
import { handle } from 'hono/aws-lambda'
import { createApp } from './app.js'

// Phase 3 supplies verified Cognito authorization and Phase 4 supplies AWS storage/queue.
export function createLambdaHandler(options: Parameters<typeof createApp>[0]) {
  return handle(createApp({ ...options, authorize: undefined }))
}
const unavailable = new Hono()
unavailable.all('*', (c) => c.json({ error: { code: 'AUTH_NOT_CONFIGURED', message: 'AWS authentication is not implemented.' } }, 503))
export const handler = handle(unavailable)
