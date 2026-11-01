import { expect, test, type Page } from '@playwright/test'

test.beforeEach(() => { test.skip(process.env.E2E_AUTH_MODE === 'local-bypass', 'Cognito protocol tests use the normal development configuration.') })

async function prepareLogin(page: Page, options: { deny?: boolean } = {}) {
  await page.route('**/api/**', async (route) => {
    expect(route.request().headers()['x-access-token']).toBe('browser-test-access-token')
    if (options.deny) { await route.fulfill({ status: 403, json: { error: { code: 'FORBIDDEN', message: 'このユーザーには利用権限がありません。' } } }); return }
    if (route.request().url().endsWith('/health')) await route.fulfill({ json: { status: 'ok', service: 'repo-sentinel-api', mode: 'mock', aiMode: 'mock' } })
    else await route.fulfill({ json: { items: [] } })
  })
  let authorization: URL | undefined
  let tokenCalls = 0
  await page.route('https://*.amazoncognito.com/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/oauth2/authorize') {
      authorization = url
      await route.fulfill({ contentType: 'text/html', body: '<h1>Managed Login test</h1>' })
    } else if (url.pathname === '/oauth2/token') {
      tokenCalls++
      const form = new URLSearchParams(route.request().postData() ?? '')
      expect(form.get('code')).toBe('browser-test-code')
      expect(form.get('code_verifier')).toBeTruthy()
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
      const profile = { sub: '11111111-2222-4333-8444-555555555555', iss: identity.issuer, aud: identity.clientId,
        exp: Math.floor(Date.now() / 1000) + 900, nonce: authorization!.searchParams.get('nonce') }
      await route.fulfill({ headers: { 'access-control-allow-origin': 'http://localhost:5173' }, json: {
        access_token: 'browser-test-access-token', refresh_token: 'browser-test-refresh-token',
        id_token: `${encode({ alg: 'RS256' })}.${encode(profile)}.test-signature`, token_type: 'Bearer', scope: 'openid email profile', expires_in: 900,
      } })
    } else if (url.pathname === '/oauth2/revoke') {
      await route.fulfill({ headers: { 'access-control-allow-origin': 'http://localhost:5173' }, json: {} })
    } else if (url.pathname === '/logout') await route.fulfill({ contentType: 'text/html', body: '<h1>Logged out</h1>' })
    else await route.abort()
  })
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'ログイン', exact: true })).toBeVisible()
  await expect(page.getByLabel('GitHubリポジトリURL')).toHaveCount(0)
  const identity: { issuer: string; clientId: string } = await page.evaluate(async () => {
    const modulePath = '/src/auth.ts'
    const { getBrowserAuth } = await import(modulePath)
    const config = getBrowserAuth().config
    return { issuer: config.issuer, clientId: config.clientId }
  })
  await page.getByRole('button', { name: 'ログイン', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Managed Login test' })).toBeVisible()
  expect(authorization!.searchParams.get('code_challenge_method')).toBe('S256')
  expect(authorization!.searchParams.get('nonce')).toBeTruthy()
  return { callback: () => `http://localhost:5173/auth/callback?code=browser-test-code&state=${authorization!.searchParams.get('state')}`, tokenCalls: () => tokenCalls }
}

test('PKCE callback → gated audit screen → in-memory logout', async ({ page }) => {
  const login = await prepareLogin(page)
  await page.goto(login.callback())
  await expect(page.getByLabel('GitHubリポジトリURL')).toBeVisible()
  await expect(page.getByText('開発環境 · COGNITO', { exact: true })).toBeVisible()
  expect(login.tokenCalls()).toBe(1)
  expect(page.url()).not.toContain('code=')
  const persistent = await page.evaluate(() => [...Object.values(sessionStorage), ...Object.values(localStorage)].join(''))
  expect(persistent).not.toContain('browser-test-access-token')
  expect(persistent).not.toContain('browser-test-refresh-token')
  await page.getByRole('button', { name: 'ログアウト', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Logged out' })).toBeVisible()
})

test('callback without a matching login state cannot reveal the application', async ({ page }) => {
  await page.goto('/auth/callback?code=invalid&state=unknown')
  await expect(page.getByRole('alert')).toContainText('ログインを完了できませんでした')
  await expect(page.getByLabel('GitHubリポジトリURL')).toHaveCount(0)
  expect(page.url()).not.toContain('code=')
})

test('a valid browser session rejected by the API cannot retain the audit screen', async ({ page }) => {
  const login = await prepareLogin(page, { deny: true })
  await page.goto(login.callback())
  await expect(page.getByRole('alert')).toContainText('このユーザーには利用権限がありません')
  await expect(page.getByLabel('GitHubリポジトリURL')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'ログアウト', exact: true })).toBeVisible()
})
