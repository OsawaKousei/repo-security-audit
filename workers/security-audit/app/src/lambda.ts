import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import { AWS_LEASE } from '@repo-sentinel/core'
import { DynamoAuditStore, awsRuntimeConfig, awsSecretArn, createDynamoAiBudget, createOpenaiKeyProvider } from '@repo-sentinel/aws'
import { createAuditRunner } from './audit.js'
import { createSqsHandler, type SqsEvent, type LambdaTime } from './sqs-handler.js'

export function createAwsWorker(env = process.env) {
  const config = awsRuntimeConfig(env)
  const client = new DynamoDBClient({ region: config.region, maxAttempts: 3, ignoreConfiguredEndpointUrls: true,
    requestHandler: { connectionTimeout: 1000, requestTimeout: 4000 } })
  const store = new DynamoAuditStore(client, config.tableName, AWS_LEASE)
  const getOpenaiKey = config.aiMode === 'openai' ? createOpenaiKeyProvider(new SecretsManagerClient({
    region: config.region, maxAttempts: 2, ignoreConfiguredEndpointUrls: true,
    requestHandler: { connectionTimeout: 1000, requestTimeout: 4000 },
  }), awsSecretArn(env, config)) : undefined
  const reserveBudget = createDynamoAiBudget(client, config.tableName)
  return createSqsHandler({ store, queueArn: config.queueArn, ownerSub: config.ownerSub, aiMode: config.aiMode,
    runAudit: (jobId, ownerSub, context) => createAuditRunner(store, {
      getOpenaiKey, hardLimitConfirmed: env.OPENAI_HARD_LIMIT_CONFIRMED === 'true', reserveBudget,
      remainingTimeMs: context ? () => context.getRemainingTimeInMillis() : undefined,
    })(jobId, ownerSub),
  })
}
let runtime: ReturnType<typeof createAwsWorker> | undefined
export async function handler(event: SqsEvent, context: LambdaTime) {
  try { runtime ??= createAwsWorker() } catch { throw new Error('AWS Worker configuration is invalid.') }
  return runtime(event, context)
}
