import { generateKeyPairSync, sign } from 'node:crypto'
import { SimpleJwksCache, type Jwk } from 'aws-jwt-verify/jwk'
import { cognitoConfig, createCognitoAuthorizer } from '../../api/app/src/auth.js'

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
export const testIssuer = 'https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_TestPool'
export const testSub = '11111111-2222-4333-8444-555555555555'
export function signedTestToken(claims: Record<string, unknown> = {}) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const text = `${encode({ alg: 'RS256', kid: 'integration-key' })}.${encode({ iss: testIssuer, sub: testSub,
    token_use: 'access', client_id: 'testclient', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 900, ...claims })}`
  return `${text}.${sign('RSA-SHA256', Buffer.from(text), keys.privateKey).toString('base64url')}`
}
export function testCognitoAuthorizer() {
  const cache = new SimpleJwksCache({ fetcher: { fetch: async () => { throw new Error('Test JWKS only; network disabled.') } } })
  cache.addJwks(`${testIssuer}/.well-known/jwks.json`, { keys: [{ ...keys.publicKey.export({ format: 'jwk' }),
    kty: 'RSA', kid: 'integration-key', alg: 'RS256', use: 'sig' } as Jwk] })
  return createCognitoAuthorizer(cognitoConfig({ COGNITO_ISSUER: testIssuer, COGNITO_CLIENT_ID: 'testclient', ALLOWED_USER_SUB: testSub }), cache)
}
