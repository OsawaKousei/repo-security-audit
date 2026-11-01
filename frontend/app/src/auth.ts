import { Log, OidcClient, WebStorageStateStore } from 'oidc-client-ts'
import { cognitoIdentity, cognitoLoginOrigin } from '@repo-sentinel/core'

Log.setLevel(Log.NONE)

export type AuthState = { status: 'loading' | 'anonymous' | 'authenticated' | 'denied' | 'error'; message?: string }
type BrowserLocation = Pick<Location, 'origin' | 'pathname' | 'href' | 'hash'>
type AuthConfig = { mode: 'cognito'; appOrigin: string; loginOrigin: string } & ReturnType<typeof cognitoIdentity>
type BypassConfig = { mode: 'local-bypass'; appOrigin: string }
type BrowserAdapter = { location: BrowserLocation; storage: Storage; navigate: (url: string) => void; replace: (url: string) => void }

export function browserAuthConfig(env: Record<string, string | undefined>, location: BrowserLocation, development: boolean): AuthConfig | BypassConfig {
  const mode = env.VITE_AUTH_MODE ?? 'cognito'
  if (mode === 'local-bypass') {
    if (!development || env.VITE_LOCAL_AUTH_BYPASS !== 'true' || !['http://localhost:5173', 'http://127.0.0.1:5173'].includes(location.origin)) {
      throw new Error('Local test authentication is not permitted here.')
    }
    return { mode, appOrigin: location.origin }
  }
  if (mode !== 'cognito' || env.VITE_LOCAL_AUTH_BYPASS === 'true') throw new Error('Cognito authentication is required.')
  const identity = cognitoIdentity(env.VITE_COGNITO_ISSUER, env.VITE_COGNITO_CLIENT_ID)
  const appOrigin = location.origin === 'http://127.0.0.1:5173' ? 'http://localhost:5173' : location.origin
  if (!appOrigin.startsWith('https://') && appOrigin !== 'http://localhost:5173') throw new Error('Use HTTPS or http://localhost:5173.')
  return { mode, appOrigin, ...identity, loginOrigin: cognitoLoginOrigin(env.VITE_COGNITO_LOGIN_URL, identity.region) }
}

export class BrowserAuth {
  readonly config: AuthConfig | BypassConfig
  private readonly browser: BrowserAdapter
  private state: AuthState = { status: 'loading' }
  private readonly listeners = new Set<() => void>()
  private readonly client?: OidcClient
  private readonly transactions?: WebStorageStateStore
  private initialization?: Promise<void>
  private session?: { accessToken: string; refreshToken?: string; expiresAt: number }
  private timer?: ReturnType<typeof setTimeout>

  constructor(
    config: AuthConfig | BypassConfig,
    browser: BrowserAdapter,
  ) {
    this.config = config
    this.browser = browser
    if (config.mode === 'cognito') {
      this.transactions = new WebStorageStateStore({ prefix: `repo-sentinel.${config.clientId}.oidc.`, store: browser.storage })
      this.client = new OidcClient({
        authority: config.issuer, client_id: config.clientId,
        redirect_uri: `${config.appOrigin}/auth/callback`, response_type: 'code', response_mode: 'query',
        scope: 'openid email profile', disablePKCE: false, loadUserInfo: false,
        stateStore: this.transactions, staleStateAgeInSeconds: 600, requestTimeoutInSeconds: 10,
        fetchRequestCredentials: 'omit',
        metadata: { issuer: config.issuer, authorization_endpoint: `${config.loginOrigin}/oauth2/authorize`,
          token_endpoint: `${config.loginOrigin}/oauth2/token`, revocation_endpoint: `${config.loginOrigin}/oauth2/revoke`,
          jwks_uri: `${config.issuer}/.well-known/jwks.json` },
      })
    }
  }

  getSnapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private update(state: AuthState) { this.state = state; for (const listener of this.listeners) listener() }
  initialize() { return this.initialization ??= this.initializeOnce() }

  private async initializeOnce() {
    if (this.config.mode === 'local-bypass') { this.update({ status: 'authenticated' }); return }
    if (this.browser.location.origin !== this.config.appOrigin) { this.browser.navigate(this.config.appOrigin); return }
    try {
      await this.client!.clearStaleState()
      if (this.browser.location.pathname !== '/auth/callback') { this.update({ status: 'anonymous' }); return }
      const callbackUrl = this.browser.location.href
      // Clear authorization codes and provider errors from browser history at once.
      this.browser.replace('/auth/callback')
      const response = await this.client!.processSigninResponse(callbackUrl)
      const profile = response.profile
      const now = Date.now() / 1000
      if (!response.id_token || !response.access_token || response.token_type?.toLowerCase() !== 'bearer' ||
        profile.iss !== this.config.issuer || profile.aud !== this.config.clientId ||
        typeof profile.exp !== 'number' || !Number.isFinite(profile.exp) || profile.exp <= now ||
        typeof response.expires_at !== 'number' || !Number.isFinite(response.expires_at) || response.expires_at <= now) throw new Error('Invalid authentication response.')
      this.session = { accessToken: response.access_token, refreshToken: response.refresh_token, expiresAt: response.expires_at }
      this.timer = setTimeout(() => this.expire(), Math.max(0, (response.expires_at - now) * 1000))
      const data = response.userState as { returnHash?: unknown } | undefined
      const hash = typeof data?.returnHash === 'string' && data.returnHash.startsWith('#/') ? data.returnHash : '#/'
      this.browser.replace(`/${hash}`)
      this.update({ status: 'authenticated' })
    } catch {
      this.session = undefined
      this.browser.replace('/')
      this.update({ status: 'error', message: 'ログインを完了できませんでした。もう一度ログインしてください。' })
    }
  }

  async login() {
    if (!this.client) return
    this.update({ status: 'loading' })
    try {
      const request = await this.client.createSigninRequest({ nonce: crypto.randomUUID(), state: { returnHash: this.browser.location.hash } })
      this.browser.navigate(request.url)
    } catch {
      this.update({ status: 'error', message: 'ログインを開始できませんでした。ブラウザーの設定と接続を確認してください。' })
    }
  }

  getAccessToken = async () => {
    if (this.state.status !== 'authenticated' || !this.session) return undefined
    if (this.session.expiresAt <= Date.now() / 1000) { this.expire(); return undefined }
    return this.session.accessToken
  }
  expire = () => {
    clearTimeout(this.timer)
    this.session = undefined
    this.update({ status: 'anonymous', message: '認証を確認できません。もう一度ログインしてください。' })
  }
  deny = () => { this.update({ status: 'denied', message: 'このユーザーには利用権限がありません。本人用のアカウントでログインしてください。' }) }

  async logout() {
    const refresh = this.session?.refreshToken
    clearTimeout(this.timer)
    this.session = undefined
    this.update({ status: 'loading' })
    if (this.config.mode === 'local-bypass') { this.update({ status: 'anonymous' }); return }
    try { for (const key of await this.transactions!.getAllKeys()) await this.transactions!.remove(key) } catch { /* Still clear the managed login cookie. */ }
    if (refresh) { try { await this.client!.revokeToken(refresh, 'refresh_token') } catch { /* Local logout still completes. */ } }
    const url = new URL('/logout', this.config.loginOrigin)
    url.searchParams.set('client_id', this.config.clientId)
    url.searchParams.set('logout_uri', `${this.config.appOrigin}/`)
    this.browser.navigate(url.href)
  }
}

let instance: BrowserAuth | undefined
export function getBrowserAuth() {
  return instance ??= new BrowserAuth(browserAuthConfig(import.meta.env, window.location, import.meta.env.DEV), {
    location: window.location, storage: window.sessionStorage,
    navigate: (url) => window.location.assign(url), replace: (url) => window.history.replaceState(null, '', url),
  })
}
