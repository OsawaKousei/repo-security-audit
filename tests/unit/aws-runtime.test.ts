import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SQSClient } from '@aws-sdk/client-sqs'
import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import { awsRuntimeConfig, awsSecretArn, createAuditEnqueuer, createOpenaiKeyProvider } from '@repo-sentinel/aws'
import { npmCommand } from '../../workers/security-audit/app/src/npm-audit.js'

const base = { NODE_ENV: 'production', APP_ENV: 'dev', AWS_REGION: 'ap-northeast-1', AWS_ACCOUNT_ID: '103492189525',
  DYNAMODB_TABLE: 'repo-sentinel-dev-jobs', AUDIT_MODE: 'audit', AI_MODE: 'mock',
  AUDIT_QUEUE_URL: 'https://sqs.ap-northeast-1.amazonaws.com/103492189525/repo-sentinel-dev-audits',
  ALLOWED_USER_SUB: '11111111-2222-4333-8444-555555555555' }
afterEach(() => { vi.useRealTimers() })
describe('AWS runtime boundaries', () => {
  it('accepts explicit AWS dev resources, defaulting to mock AI', () => {
    expect(awsRuntimeConfig(base)).toMatchObject({ aiMode: 'mock', tableName: base.DYNAMODB_TABLE, ownerSub: base.ALLOWED_USER_SUB })
    expect(awsRuntimeConfig({ ...base, AI_MODE: 'openai', OPENAI_HARD_LIMIT_CONFIRMED: 'true' }).aiMode).toBe('openai')
  })
  it.each([{ NODE_ENV: 'development' }, { APP_ENV: 'local' }, { APP_ENV: 'prod' }, { AUTH_MODE: 'local-bypass' },
    { LOCAL_AUTH_BYPASS: 'true' }, { AWS_ENDPOINT_URL: 'http://localhost:8000' }, { DYNAMODB_ENDPOINT: 'http://dynamodb:8000' },
    { DYNAMODB_TABLE: 'other-jobs' }, { ALLOWED_USER_SUB: 'local-user' }, { AI_MODE: 'openai' },
    { AUDIT_QUEUE_URL: 'https://evil.example' }, { AWS_REGION: 'us-east-1' }])('rejects unsafe or incomplete configuration %j', (overrides) => {
    expect(() => awsRuntimeConfig({ ...base, ...overrides })).toThrow()
  })
  it('only accepts the environment-specific OpenAI secret ARN', () => {
    const arn = 'arn:aws:secretsmanager:ap-northeast-1:103492189525:secret:repo-sentinel-dev/openai-api-key-Ab1234'
    expect(awsSecretArn({ OPENAI_SECRET_ARN: arn }, awsRuntimeConfig(base))).toBe(arn)
    expect(() => awsSecretArn({ OPENAI_SECRET_ARN: arn.replace('-dev/', '-prod/') }, awsRuntimeConfig(base))).toThrow()
  })
  it('sends a strict versioned owner/job message without credentials', async () => {
    const send = vi.fn().mockResolvedValue({})
    const enqueue = createAuditEnqueuer({ send } as unknown as SQSClient, base.AUDIT_QUEUE_URL)
    await enqueue('01ARZ3NDEKTSV4RRFFQ69G5FAV', base.ALLOWED_USER_SUB)
    expect(send.mock.calls[0][0].input).toEqual({ QueueUrl: base.AUDIT_QUEUE_URL,
      MessageBody: JSON.stringify({ version: 1, jobId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', ownerSub: base.ALLOWED_USER_SUB }) })
    await expect(enqueue('invalid', base.ALLOWED_USER_SUB)).rejects.toThrow()
    expect(send).toHaveBeenCalledTimes(1)
  })
  it('loads AWSCURRENT once, caches in memory and expires after five minutes', async () => {
    vi.useFakeTimers()
    const send = vi.fn().mockResolvedValue({ SecretString: `sk-${'a'.repeat(30)}` })
    const get = createOpenaiKeyProvider({ send } as unknown as SecretsManagerClient, 'test-secret-arn')
    await Promise.all([get(), get()])
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0].input).toEqual({ SecretId: 'test-secret-arn', VersionStage: 'AWSCURRENT' })
    await vi.advanceTimersByTimeAsync(300_001)
    await get()
    expect(send).toHaveBeenCalledTimes(2)
  })
  it('fails closed on missing secrets and suppresses raw SDK errors', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('sensitive SDK error')).mockResolvedValue({ SecretString: '{}' })
    const get = createOpenaiKeyProvider({ send } as unknown as SecretsManagerClient, 'test-secret-arn')
    await expect(get()).rejects.toMatchObject({ code: 'AI_NOT_CONFIGURED' })
    await expect(get()).rejects.not.toHaveProperty('message', 'sensitive SDK error')
    expect(send).toHaveBeenCalledTimes(2)
  })
  it('uses the pinned npm Layer through Node, rejecting untrusted command paths', () => {
    expect(npmCommand({ NODE_ENV: 'production', APP_ENV: 'dev', NPM_CLI_PATH: '/opt/nodejs/node_modules/npm/bin/npm-cli.js' }))
      .toEqual({ file: process.execPath, args: ['/opt/nodejs/node_modules/npm/bin/npm-cli.js'] })
    expect(() => npmCommand({ NODE_ENV: 'production', APP_ENV: 'dev', NPM_CLI_PATH: '/tmp/untrusted.js' })).toThrow()
    expect(() => npmCommand({ AWS_LAMBDA_FUNCTION_NAME: 'worker' })).toThrow()
  })
})
