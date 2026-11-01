import { handle } from 'hono/aws-lambda'
import { Hono } from 'hono'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { SQSClient } from '@aws-sdk/client-sqs'
import { AWS_LEASE } from '@repo-sentinel/core'
import { DynamoAuditStore, awsRuntimeConfig, createAuditEnqueuer } from '@repo-sentinel/aws'
import { createApp } from './app.js'
import { cognitoConfig, createCognitoAuthorizer } from './auth.js'

// AWS entry points never import local authentication or the local dispatcher.
export function createLambdaHandler(options: Parameters<typeof createApp>[0], env = process.env) {
  return handle(createApp({ ...options, authorize: createCognitoAuthorizer(cognitoConfig(env)) }))
}
export function createAwsApi(env = process.env) {
  const config = awsRuntimeConfig(env)
  const client = new DynamoDBClient({ region: config.region, maxAttempts: 3, ignoreConfiguredEndpointUrls: true,
    requestHandler: { connectionTimeout: 1000, requestTimeout: 4000 } })
  const store = new DynamoAuditStore(client, config.tableName, AWS_LEASE)
  const queue = new SQSClient({ region: config.region, maxAttempts: 1, ignoreConfiguredEndpointUrls: true,
    requestHandler: { connectionTimeout: 1000, requestTimeout: 4000 } })
  return createLambdaHandler({ store, mode: 'audit', aiMode: config.aiMode, execution: 'sqs',
    enqueue: createAuditEnqueuer(queue, config.queueUrl), beforeRequest: (owner) => store.expireStaleAudit(owner) }, env)
}
let runtime: ReturnType<typeof createAwsApi> | undefined
const unavailable = handle(new Hono().all('*', (c) => c.json({ error: {
  code: 'AWS_RUNTIME_NOT_CONFIGURED', message: 'AWS runtime configuration is invalid.',
} }, 503)))
export const handler: ReturnType<typeof createLambdaHandler> = async (event, context) => {
  try { runtime ??= createAwsApi() } catch {
    return unavailable(event, context)
  }
  return runtime(event, context)
}
