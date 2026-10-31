export const LOCAL_OWNER = 'local-user'

// This module is only used by local entry points. No AWS configuration is accepted.
export function localConfig(env = process.env) {
  if (env.APP_ENV !== 'local' || env.LOCAL_AUTH_BYPASS !== 'true' || env.AUDIT_MODE !== 'mock' ||
      env.NODE_ENV === 'production' || env.AWS_LAMBDA_FUNCTION_NAME || env.AWS_EXECUTION_ENV) {
    throw new Error('Phase 1 requires explicit local mock configuration; AWS execution is disabled.')
  }
  const endpoint = new URL(env.DYNAMODB_ENDPOINT ?? '')
  if (endpoint.protocol !== 'http:' || !['dynamodb', 'localhost', '127.0.0.1'].includes(endpoint.hostname) ||
      endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
    throw new Error('DynamoDB endpoint must be a local HTTP endpoint.')
  }
  const tableName = env.DYNAMODB_TABLE ?? 'security-audit-jobs-local'
  if (!/^[A-Za-z0-9_-]+-local$/.test(tableName)) throw new Error('Local table name must end with -local.')
  const outcome = env.MOCK_OUTCOME ?? 'success'
  if (!['success', 'failure'].includes(outcome)) throw new Error('Invalid MOCK_OUTCOME.')
  return { endpoint: endpoint.href, tableName, outcome: outcome as 'success' | 'failure' }
}
