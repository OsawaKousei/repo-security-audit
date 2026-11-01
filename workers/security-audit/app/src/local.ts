import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ulid } from 'ulid'
import { AuditError, createAuditSchema, jobIdSchema, repositoryFromUrl } from '@repo-sentinel/core'
import { DynamoAuditStore, dynamoClient, ensureTable, localConfig } from '@repo-sentinel/aws'
import { createAuditRunner, createMockRunner } from './audit.js'

async function main() {
  const config = localConfig()
  if (config.mode === 'audit' && config.aiMode === 'openai' &&
      (!process.env.OPENAI_API_KEY || process.env.OPENAI_HARD_LIMIT_CONFIRMED !== 'true')) {
    throw new AuditError('AI_NOT_CONFIGURED', 'Configure API key and dedicated-project hard spend limit first.', 503)
  }
  const args = process.argv.slice(2)
  let jobId: string
  let repository: string | undefined
  if (args.length === 2 && args[0] === '--repository') {
    const input = createAuditSchema.parse({ repositoryUrl: args[1] })
    jobId = ulid()
    repository = repositoryFromUrl(input.repositoryUrl)
  } else if (args.length === 1) jobId = jobIdSchema.parse(args[0])
  else throw new AuditError('INVALID_INPUT', 'Use <job-id> or --repository https://github.com/owner/repo', 400)
  const client = dynamoClient(config.endpoint)
  try {
    await ensureTable(client, config.tableName)
    const store = new DynamoAuditStore(client, config.tableName)
    if (repository) await store.create(config.ownerSub, {
      jobId, repository, status: 'PENDING', mode: config.mode, aiMode: config.aiMode,
      createdAt: new Date().toISOString(), attemptCount: 0,
    })
    const audit = await store.get(config.ownerSub, jobId)
    if (!audit) throw new AuditError('NOT_FOUND', 'Job not found for the configured owner.', 404)
    if (audit.mode !== config.mode || (audit.aiMode ?? 'mock') !== config.aiMode) throw new AuditError('MODE_MISMATCH', 'Worker mode must match the stored job.', 409)
    console.log(JSON.stringify({ jobId, repository: audit.repository, mode: audit.mode, aiMode: audit.aiMode ?? 'mock' }))
    const runner = config.mode === 'mock' ? createMockRunner(store, { outcome: config.outcome }) : createAuditRunner(store, {
      githubToken: process.env.GITHUB_TOKEN, openaiKey: process.env.OPENAI_API_KEY,
      hardLimitConfirmed: process.env.OPENAI_HARD_LIMIT_CONFIRMED === 'true',
      budgetDirectory: process.env.AI_BUDGET_DIR ?? resolve(fileURLToPath(new URL('../../../../', import.meta.url)), '.local/ai-usage'),
    })
    await runner(jobId, config.ownerSub)
    const result = await store.get(config.ownerSub, jobId)
    console.log(JSON.stringify(result))
    if (result?.status !== 'COMPLETED') process.exitCode = 1
  } finally { client.destroy() }
}
main().catch((error: unknown) => {
  // Do not print transport errors, environment values, or raw API bodies.
  console.error(JSON.stringify({ errorCode: error instanceof AuditError ? error.code : 'CONFIGURATION_ERROR' }))
  process.exitCode = 1
})
