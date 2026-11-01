import { InMemoryWebStorage } from 'oidc-client-ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserAuth, browserAuthConfig } from '../../frontend/app/src/auth'

const origin = 'http://localhost:5173'
const issuer = 'https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_TestPool'
const loginOrigin = 'https://test.auth.ap-northeast-1.amazoncognito.com'
const environment = { VITE_AUTH_MODE: 'cognito', VITE_COGNITO_ISSUER: issuer, VITE_COGNITO_CLIENT_ID: 'testclient', VITE_COGNITO_LOGIN_URL: loginOrigin }
function fixture(href = `${origin}/#/audits`, storage = new InMemoryWebStorage()) {
  const url = new URL(href)
  const location = { href: url.href, origin: url.origin, pathname: url.pathname, hash: url.hash }
  const navigate = vi.fn<(url: string) => void>()
  const replace = vi.fn((value: string) => {
    const next = new URL(value, origin)
    Object.assign(location, { href: next.href, origin: next.origin, pathname: next.pathname, hash: next.hash })
  })
  const auth = new BrowserAuth(browserAuthConfig(environment, location, true), { location, storage, navigate, replace })
  return { auth, location, storage, navigate, replace }
}
async function pending() {
  const f = fixture()
  await f.auth.initialize()
  await f.auth.login()
  return { ...f, request: new URL(f.navigate.mock.calls[0][0]) }
}
function tokenResponse(request: URL, claims: Record<string, unknown> = {}) {
  // Browser tests mock only the trusted HTTPS token endpoint. API tests separately
  // verify actual RSA signatures; no test key or JWT is accepted by the live API.
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const profile = { sub: '11111111-2222-4333-8444-555555555555', iss: issuer, aud: 'testclient',
    nonce: request.searchParams.get('nonce'), exp: Math.floor(Date.now() / 1000) + 900, ...claims }
  return { access_token: 'access-token-for-test', refresh_token: 'refresh-token-for-test',
    id_token: `${encode({ alg: 'RS256' })}.${encode(profile)}.signature`, expires_in: 900, token_type: 'Bearer', scope: 'openid email profile' }
}
function callback(f: Awaited<ReturnType<typeof pending>>, state = f.request.searchParams.get('state')!) {
  return fixture(`${origin}/auth/callback?code=one-time-code&state=${state}`, f.storage)
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('browser Cognito authorization code flow', () => {
  it('uses S256 PKCE, an unpredictable state and nonce, with no token persisted', async () => {
    const f = await pending()
    expect(f.request.origin).toBe(loginOrigin)
    expect(f.request.pathname).toBe('/oauth2/authorize')
    expect(f.request.searchParams.get('redirect_uri')).toBe(`${origin}/auth/callback`)
    expect(f.request.searchParams.get('response_type')).toBe('code')
    expect(f.request.searchParams.get('code_challenge_method')).toBe('S256')
    expect(f.request.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(f.request.searchParams.get('state')!.length).toBeGreaterThan(20)
    expect(f.request.searchParams.get('nonce')!.length).toBeGreaterThan(20)
    expect(f.request.searchParams.has('client_secret')).toBe(false)
    expect(f.storage.length).toBe(1)
    expect(Object.values(f.storage).join('')).not.toContain('access_token')
  })
  it('exchanges once, uses the matching verifier, clears the URL, and keeps tokens only in memory', async () => {
    const f = await pending()
    const fetch = vi.fn(async () => Response.json(tokenResponse(f.request)))
    vi.stubGlobal('fetch', fetch)
    const c = callback(f)
    const first = c.auth.initialize()
    expect(c.auth.initialize()).toBe(first)
    await first
    expect(c.auth.getSnapshot().status).toBe('authenticated')
    expect(await c.auth.getAccessToken()).toBe('access-token-for-test')
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, options] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${loginOrigin}/oauth2/token`)
    const body = new URLSearchParams(options.body as URLSearchParams)
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('client_id')).toBe('testclient')
    expect(body.get('redirect_uri')).toBe(`${origin}/auth/callback`)
    expect(body.get('code')).toBe('one-time-code')
    const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body.get('code_verifier')!))).toString('base64url')
    expect(challenge).toBe(f.request.searchParams.get('code_challenge'))
    expect(c.replace.mock.calls[0][0]).toBe('/auth/callback')
    expect(c.location.href).toBe(`${origin}/#/audits`)
    expect(c.storage.length).toBe(0)
    const reloaded = fixture(`${origin}/#/audits`, c.storage)
    await reloaded.auth.initialize()
    expect(reloaded.auth.getSnapshot().status).toBe('anonymous')
    expect(await reloaded.auth.getAccessToken()).toBeUndefined()
  })
  it('rejects mismatched state before contacting the token endpoint', async () => {
    const f = await pending()
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const c = callback(f, 'attacker-state')
    await c.auth.initialize()
    expect(c.auth.getSnapshot().status).toBe('error')
    expect(fetch).not.toHaveBeenCalled()
    expect(await c.auth.getAccessToken()).toBeUndefined()
    expect(c.location.href).toBe(`${origin}/`)
  })
  it.each([{ nonce: 'wrong' }, { nonce: undefined }, { iss: 'https://evil.example' }, { aud: 'other-client' }, { exp: 1 }])('rejects ID token claim mismatch %j', async (claims) => {
    const f = await pending()
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(tokenResponse(f.request, claims))))
    const c = callback(f)
    await c.auth.initialize()
    expect(c.auth.getSnapshot().status).toBe('error')
    expect(await c.auth.getAccessToken()).toBeUndefined()
    expect(c.storage.length).toBe(0)
  })
  it('rejects abandoned state after ten minutes', async () => {
    const f = await pending()
    await vi.advanceTimersByTimeAsync(601_000)
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const c = callback(f)
    await c.auth.initialize()
    expect(c.auth.getSnapshot().status).toBe('error')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('does not replay a consumed authorization response', async () => {
    const f = await pending()
    const fetch = vi.fn(async () => Response.json(tokenResponse(f.request)))
    vi.stubGlobal('fetch', fetch)
    await callback(f).auth.initialize()
    const replay = callback(f)
    await replay.auth.initialize()
    expect(replay.auth.getSnapshot().status).toBe('error')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('expires in-memory credentials without silent refresh or API retries', async () => {
    const f = await pending()
    const fetch = vi.fn(async () => Response.json(tokenResponse(f.request)))
    vi.stubGlobal('fetch', fetch)
    const c = callback(f)
    await c.auth.initialize()
    await vi.advanceTimersByTimeAsync(901_000)
    expect(c.auth.getSnapshot().status).toBe('anonymous')
    expect(await c.auth.getAccessToken()).toBeUndefined()
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('clears local credentials and pending state and logs out of Cognito even if revocation fails', async () => {
    const f = await pending()
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(tokenResponse(f.request))).mockRejectedValue(new Error('offline'))
    vi.stubGlobal('fetch', fetch)
    const c = callback(f)
    await c.auth.initialize()
    await c.auth.logout()
    expect(await c.auth.getAccessToken()).toBeUndefined()
    expect(c.storage.length).toBe(0)
    const url = new URL(c.navigate.mock.calls[0][0])
    expect(url.origin).toBe(loginOrigin)
    expect(url.pathname).toBe('/logout')
    expect(url.searchParams.get('client_id')).toBe('testclient')
    expect(url.searchParams.get('logout_uri')).toBe(`${origin}/`)
    expect(url.href).not.toContain('token-for-test')
  })
  it('canonicalizes the local Cognito origin before starting authentication', async () => {
    const f = fixture('http://127.0.0.1:5173/')
    await f.auth.initialize()
    expect(f.navigate).toHaveBeenCalledWith(origin)
  })
  it('only allows the test bypass on a development loopback origin', () => {
    const location = fixture().location
    const env = { VITE_AUTH_MODE: 'local-bypass', VITE_LOCAL_AUTH_BYPASS: 'true' }
    expect(browserAuthConfig(env, location, true).mode).toBe('local-bypass')
    expect(() => browserAuthConfig(env, location, false)).toThrow()
    expect(() => browserAuthConfig(env, { ...location, origin: 'https://repo-sentinel-dev.prj.kupac.co.jp' }, true)).toThrow()
    expect(() => browserAuthConfig({ ...environment, VITE_LOCAL_AUTH_BYPASS: 'true' }, location, true)).toThrow()
  })
})
