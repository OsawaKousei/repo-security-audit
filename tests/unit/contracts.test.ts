import { describe, expect, it } from 'vitest'
import { auditSchema, repositoryFromUrl, repositoryUrlSchema } from '@repo-sentinel/core'
import { localConfig } from '@repo-sentinel/aws'
import { authorizeLocal } from '../../api/app/src/local-auth.js'

describe('repository input', () => {
  it('normalizes only a GitHub repository URL', () => {
    expect(repositoryFromUrl(' https://github.com/example/project.git/ ')).toBe('example/project')
  })
  it.each([
    'http://github.com/a/b', 'https://evil.example/a/b', 'https://github.com.evil.example/a/b',
    'https://name:pass@github.com/a/b', 'https://github.com/a/b?ref=main', 'https://github.com/a/b#main',
    'https://github.com/a/b/tree/main', 'https://github.com/a/%2e%2e', 'https://github.com/a/..',
    'https://github.com/a/.git', 'https://github.com/-invalid/b', 'https://github.com/a/b\\c',
  ])('rejects %s', (url) => expect(repositoryUrlSchema.safeParse(url).success).toBe(false))
  it('rejects completed jobs without evidence and pending jobs with results', () => {
    const base = { jobId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', repository: 'a/b', createdAt: new Date().toISOString(), attemptCount: 0, mode: 'mock' }
    expect(auditSchema.safeParse({ ...base, status: 'COMPLETED' }).success).toBe(false)
    expect(auditSchema.safeParse({ ...base, status: 'PENDING', report: {} }).success).toBe(false)
  })
})

const env = { APP_ENV: 'local', NODE_ENV: 'development', AUTH_MODE: 'local-bypass', LOCAL_AUTH_BYPASS: 'true', AUDIT_MODE: 'mock', DYNAMODB_ENDPOINT: 'http://dynamodb:8000' }
describe('local-only execution', () => {
  it('requires explicit local mock settings', () => {
    expect(localConfig(env).tableName).toBe('security-audit-jobs-local')
    expect(() => localConfig({})).toThrow()
  })
  it('supports explicit local audit and AI modes without accepting AWS execution', () => {
    expect(localConfig({ ...env, AUDIT_MODE: 'audit', AI_MODE: 'openai' })).toMatchObject({ mode: 'audit', aiMode: 'openai' })
    expect(() => localConfig({ ...env, AI_MODE: 'openai' })).toThrow()
  })
  it('uses the allowed Cognito sub in normal local development', () => {
    const cognito = { ...env, AUTH_MODE: 'cognito', LOCAL_AUTH_BYPASS: 'false',
      COGNITO_ISSUER: 'https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_TestPool',
      COGNITO_CLIENT_ID: 'testclient', ALLOWED_USER_SUB: '11111111-2222-4333-8444-555555555555' }
    expect(localConfig(cognito)).toMatchObject({ authMode: 'cognito', ownerSub: cognito.ALLOWED_USER_SUB })
    expect(() => localConfig({ ...cognito, LOCAL_AUTH_BYPASS: 'true' })).toThrow()
    expect(() => localConfig({ ...cognito, ALLOWED_USER_SUB: 'local-user' })).toThrow()
  })
  it.each([
    { APP_ENV: 'dev' }, { APP_ENV: 'prod' }, { NODE_ENV: 'production' }, { LOCAL_AUTH_BYPASS: 'false' },
    { AUDIT_MODE: 'real' }, { AWS_LAMBDA_FUNCTION_NAME: 'function' }, { AWS_EXECUTION_ENV: 'AWS_Lambda_nodejs24.x' },
    { DYNAMODB_ENDPOINT: 'https://dynamodb.ap-northeast-1.amazonaws.com' }, { DYNAMODB_TABLE: 'jobs-prod' },
    { DYNAMODB_ENDPOINT: 'http://localhost:8000@evil.example' },
  ])('rejects unsafe configuration %j', (override) => expect(() => localConfig({ ...env, ...override })).toThrow())
  it('allows loopback and the Compose proxy but rejects external hosts and origins', () => {
    expect(authorizeLocal(new Request('http://localhost:3000/api/audits'))).toBe('local-user')
    expect(authorizeLocal(new Request('http://api:3000/api/audits', { headers: { Origin: 'http://localhost:5173' } }))).toBe('local-user')
    expect(authorizeLocal(new Request('http://evil.example/api/audits'))).toBeUndefined()
    expect(authorizeLocal(new Request('http://localhost:3000/api/audits', { headers: { Origin: 'https://evil.example' } }))).toBeUndefined()
    expect(authorizeLocal(new Request('http://localhost:3000/api/audits', { headers: { 'Sec-Fetch-Site': 'cross-site' } }))).toBeUndefined()
  })
})
