import { serve } from '@hono/node-server'
import { DynamoAuditStore, dynamoClient, ensureTable, localConfig } from '@repo-sentinel/aws'
import { createMockRunner, startMockDispatcher } from '@repo-sentinel/worker'
import { createApp } from './app.js'
import { authorizeLocal } from './local-auth.js'

const config = localConfig()
const client = dynamoClient(config.endpoint)
await ensureTable(client, config.tableName)
const store = new DynamoAuditStore(client, config.tableName)
const stop = startMockDispatcher(store, createMockRunner(store, { outcome: config.outcome }))
const app = createApp({ store, authorize: authorizeLocal })
const server = serve({ fetch: app.fetch, hostname: '0.0.0.0', port: 3000 }, () => {
  console.log('Local mock API listening on port 3000')
})
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { stop(); server.close(() => { client.destroy(); process.exit(0) }) })
}
