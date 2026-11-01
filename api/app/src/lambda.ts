import { Hono } from 'hono'
import { handle } from 'hono/aws-lambda'
import { createApp } from './app.js'
import { cognitoConfig, createCognitoAuthorizer } from './auth.js'

// Phase 4 supplies AWS storage/queue. No local bypass is imported by this entry point.
export function createLambdaHandler(options: Parameters<typeof createApp>[0], env = process.env) {
  return handle(createApp({ ...options, authorize: createCognitoAuthorizer(cognitoConfig(env)) }))
}
const unavailable = new Hono()
unavailable.all('*', (c) => c.json({ error: { code: 'AWS_RUNTIME_NOT_CONFIGURED', message: 'AWS storage and queue are not configured.' } }, 503))
export const handler = handle(unavailable)
