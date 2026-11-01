import { cognitoIdentity, cognitoSubSchema } from '@repo-sentinel/core'

export const LOCAL_OWNER = 'local-user'

// Only local data/queue execution is accepted. Cognito can authenticate the user.
export function localConfig(env = process.env) {
  if (env.APP_ENV !== 'local' || !['mock', 'audit'].includes(env.AUDIT_MODE ?? '') ||
      env.NODE_ENV === 'production' || env.AWS_LAMBDA_FUNCTION_NAME || env.AWS_EXECUTION_ENV) {
    throw new Error('Explicit local configuration is required; AWS execution is disabled.')
  }
  const authMode = env.AUTH_MODE ?? 'cognito'
  if (!['cognito', 'local-bypass'].includes(authMode) ||
    (authMode === 'local-bypass' ? env.LOCAL_AUTH_BYPASS !== 'true' : env.LOCAL_AUTH_BYPASS === 'true')) {
    throw new Error('Choose Cognito authentication or an explicit local-only test bypass.')
  }
  const ownerSub = authMode === 'cognito' ? cognitoSubSchema.parse(env.ALLOWED_USER_SUB) : LOCAL_OWNER
  if (authMode === 'cognito') cognitoIdentity(env.COGNITO_ISSUER, env.COGNITO_CLIENT_ID)
  const endpoint = new URL(env.DYNAMODB_ENDPOINT ?? '')
  if (endpoint.protocol !== 'http:' || !['dynamodb', 'localhost', '127.0.0.1'].includes(endpoint.hostname) ||
      endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
    throw new Error('DynamoDB endpoint must be a local HTTP endpoint.')
  }
  const tableName = env.DYNAMODB_TABLE ?? 'security-audit-jobs-local'
  if (!/^[A-Za-z0-9_-]+-local$/.test(tableName)) throw new Error('Local table name must end with -local.')
  const outcome = env.MOCK_OUTCOME ?? 'success'
  if (!['success', 'failure'].includes(outcome)) throw new Error('Invalid MOCK_OUTCOME.')
  const aiMode = env.AI_MODE ?? 'mock'
  if (!['mock', 'openai'].includes(aiMode) || (env.AUDIT_MODE === 'mock' && aiMode !== 'mock')) throw new Error('Invalid AI_MODE.')
  return { endpoint: endpoint.href, tableName, ownerSub, authMode: authMode as 'cognito' | 'local-bypass', outcome: outcome as 'success' | 'failure', mode: env.AUDIT_MODE as 'mock' | 'audit', aiMode: aiMode as 'mock' | 'openai' }
}
