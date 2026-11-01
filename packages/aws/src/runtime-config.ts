import { cognitoSubSchema } from '@repo-sentinel/core'

// Local entry points never call this. No Local endpoint or static credential fallback.
export function awsRuntimeConfig(env = process.env) {
  if (env.NODE_ENV !== 'production' || env.APP_ENV !== 'dev' || env.LOCAL_AUTH_BYPASS === 'true' ||
    (env.AUTH_MODE && env.AUTH_MODE !== 'cognito') || Object.keys(env).some((key) =>
      (key === 'DYNAMODB_ENDPOINT' || key.startsWith('AWS_ENDPOINT_URL')) && env[key])) {
    throw new Error('Explicit AWS dev configuration without endpoint overrides is required.')
  }
  const region = env.AWS_REGION
  const accountId = env.AWS_ACCOUNT_ID
  const prefix = env.RESOURCE_PREFIX ?? 'repo-sentinel-dev'
  if (region !== 'ap-northeast-1' || !accountId || !/^\d{12}$/.test(accountId) || !/^[a-z][a-z0-9-]+-dev$/.test(prefix) ||
    env.DYNAMODB_TABLE !== `${prefix}-jobs`) throw new Error('Invalid AWS resource configuration.')
  const aiMode = env.AI_MODE ?? 'mock'
  if (env.AUDIT_MODE !== 'audit' || !['mock', 'openai'].includes(aiMode) ||
    (aiMode === 'openai' && env.OPENAI_HARD_LIMIT_CONFIRMED !== 'true')) throw new Error('Invalid AWS audit mode or missing hard-limit confirmation.')
  const queueUrl = `https://sqs.${region}.amazonaws.com/${accountId}/${prefix}-audits`
  const queueArn = `arn:aws:sqs:${region}:${accountId}:${prefix}-audits`
  if (env.AUDIT_QUEUE_URL !== queueUrl) throw new Error('Unexpected audit queue URL.')
  return { region, accountId, prefix, tableName: env.DYNAMODB_TABLE, queueUrl, queueArn,
    ownerSub: cognitoSubSchema.parse(env.ALLOWED_USER_SUB), aiMode: aiMode as 'mock' | 'openai' }
}

export function awsSecretArn(env: NodeJS.ProcessEnv, config: ReturnType<typeof awsRuntimeConfig>) {
  const arn = env.OPENAI_SECRET_ARN
  const prefix = `arn:aws:secretsmanager:${config.region}:${config.accountId}:secret:${config.prefix}/openai-api-key-`
  if (!arn?.startsWith(prefix) || !/^[A-Za-z0-9]{6}$/.test(arn.slice(prefix.length))) throw new Error('Unexpected OpenAI secret ARN.')
  return arn
}
