import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { DynamoAuditStore, dynamoClient, ensureTable, localConfig } from '@repo-sentinel/aws'
import { createMockRunner, startMockDispatcher } from '@repo-sentinel/worker'
import { createApp } from './app.js'
import { authorizeLocal, isLocalRequest } from './local-auth.js'
import { cognitoConfig, createCognitoAuthorizer } from './auth.js'

const config = localConfig()
const client = dynamoClient(config.endpoint)
await ensureTable(client, config.tableName)
const store = new DynamoAuditStore(client, config.tableName)
const stop = startMockDispatcher(store, createMockRunner(store, { outcome: config.outcome }))
const verify = config.authMode === 'cognito' ? createCognitoAuthorizer(cognitoConfig()) : authorizeLocal
const api = createApp({ store, authorize: (request) => isLocalRequest(request) ? verify(request) : undefined, mode: config.mode, aiMode: config.aiMode })
const app = new Hono()
app.get('/healthz', (c) => c.json({ status: 'ok' }))
app.route('/', api)
const server = serve({ fetch: app.fetch, hostname: '0.0.0.0', port: 3000 }, () => {
  console.log(`Local ${config.mode} API listening on port 3000`)
})
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { stop(); server.close(() => { client.destroy(); process.exit(0) }) })
}
