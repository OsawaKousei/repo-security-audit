import { jobIdSchema } from '@repo-sentinel/core'
import { DynamoAuditStore, dynamoClient, ensureTable, localConfig, LOCAL_OWNER } from '@repo-sentinel/aws'
import { createMockRunner } from './audit.js'

const config = localConfig()
const jobId = jobIdSchema.parse(process.argv[2])
const client = dynamoClient(config.endpoint)
try {
  await ensureTable(client, config.tableName)
  const store = new DynamoAuditStore(client, config.tableName)
  if (!await store.get(LOCAL_OWNER, jobId)) throw new Error('Job not found for local user.')
  await createMockRunner(store, { outcome: config.outcome })(jobId, LOCAL_OWNER)
  console.log(JSON.stringify(await store.get(LOCAL_OWNER, jobId)))
} finally { client.destroy() }
