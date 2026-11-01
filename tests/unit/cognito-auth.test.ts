import { generateKeyPairSync, sign } from 'node:crypto'
import { SimpleJwksCache, type Jwk } from 'aws-jwt-verify/jwk'
import { describe, expect, it, vi } from 'vitest'
import { cognitoConfig, createCognitoAuthorizer } from '../../api/app/src/auth.js'
import { createApp } from '../../api/app/src/app.js'
import { createLambdaHandler } from '../../api/app/src/lambda.js'
import type { AuditStore } from '@repo-sentinel/core'

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
const wrongKeys = generateKeyPairSync('rsa', { modulusLength: 2048 })
const issuer = 'https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_TestPool'
const sub = '11111111-2222-4333-8444-555555555555'
const env = { COGNITO_ISSUER: issuer, COGNITO_CLIENT_ID: 'testclient', ALLOWED_USER_SUB: sub }
const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kty: 'RSA', kid: 'test-key', alg: 'RS256', use: 'sig' } as Jwk
function token(claims: Record<string, unknown> = {}, options: { wrongKey?: boolean; kid?: string } = {}) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const value = `${encode({ alg: 'RS256', kid: options.kid ?? 'test-key' })}.${encode({
    iss: issuer, sub, token_use: 'access', client_id: 'testclient', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 900, ...claims,
  })}`
  return `${value}.${sign('RSA-SHA256', Buffer.from(value), options.wrongKey ? wrongKeys.privateKey : keys.privateKey).toString('base64url')}`
}
function fixture() {
  const fetcher = { fetch: vi.fn(async (): Promise<ArrayBuffer> => { throw new Error('JWKS unavailable') }) }
  const cache = new SimpleJwksCache({ fetcher })
  cache.addJwks(`${issuer}/.well-known/jwks.json`, { keys: [jwk] })
  const list = vi.fn(async () => ({ items: [] }))
  const app = createApp({ store: { list } as unknown as AuditStore, authorize: createCognitoAuthorizer(cognitoConfig(env), cache) })
  const request = (jwt: string, path = '/api/health') => app.request(path, { headers: { 'X-Access-Token': jwt } })
  return { app, request, list, fetcher }
}

describe('Cognito access-token authorization', () => {
  it('verifies an RSA signature and passes only the verified sub to storage', async () => {
    const f = fixture()
    expect((await f.request(token(), '/api/audits')).status).toBe(200)
    expect(f.list).toHaveBeenCalledWith(sub, 20, undefined)
    expect(f.fetcher.fetch).not.toHaveBeenCalled()
  })
  it.each([
    { exp: Math.floor(Date.now() / 1000) - 1 }, { exp: undefined }, { exp: 'tomorrow' },
    { iss: 'https://evil.example' }, { client_id: 'other-client' },
    { token_use: 'id', aud: 'testclient' }, { nbf: Math.floor(Date.now() / 1000) + 3600 }, { sub: undefined },
  ])('rejects invalid or missing claims %j', async (claims) => {
    const f = fixture()
    const response = await f.request(token(claims))
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } })
    expect(f.list).not.toHaveBeenCalled()
  })
  it('rejects a forged signature before checking the owner', async () => {
    expect((await fixture().request(token({}, { wrongKey: true }))).status).toBe(401)
  })
  it('returns 403 only for a valid signed token belonging to another user', async () => {
    const f = fixture()
    const response = await f.request(token({ sub: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }), '/api/audits')
    expect(response.status).toBe(403)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.json()).toEqual({ error: { code: 'FORBIDDEN', message: 'このユーザーには利用権限がありません。' } })
    expect(f.list).not.toHaveBeenCalled()
  })
  it('fails closed if a rotated key cannot be retrieved', async () => {
    const f = fixture()
    expect((await f.request(token({}, { kid: 'new-key' }))).status).toBe(401)
    expect(f.fetcher.fetch).toHaveBeenCalledWith(`${issuer}/.well-known/jwks.json`)
  })
  it.each(['', 'Bearer abc.def.ghi', 'abc.def.ghi,second', 'a'.repeat(8193)])('rejects malformed headers', async (value) => {
    const f = fixture()
    expect((await f.request(value)).status).toBe(401)
    expect(f.fetcher.fetch).not.toHaveBeenCalled()
  })
  it('does not use Authorization or caller-provided owner headers', async () => {
    const response = await fixture().app.request('/api/audits', { headers: { Authorization: `Bearer ${token()}`, 'X-Owner-Sub': sub } })
    expect(response.status).toBe(401)
  })
  it('rejects an unconfigured or bypassed Lambda auth factory', () => {
    const store = {} as AuditStore
    expect(() => createLambdaHandler({ store }, {})).toThrow()
    expect(() => createLambdaHandler({ store, authorize: () => sub }, { ...env, LOCAL_AUTH_BYPASS: 'true' })).toThrow()
  })
})
