import { useEffect, useState, type ReactNode } from 'react'
import { getBrowserAuth, type BrowserAuth, type AuthState } from './auth'
import { AuthContext } from './auth-context'
import { configureApiAuthentication } from './api'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [auth] = useState<BrowserAuth | undefined>(() => { try { return getBrowserAuth() } catch { return undefined } })
  const [state, setState] = useState<AuthState>(() => auth?.getSnapshot() ?? {
    status: 'error', message: '認証設定を読み込めません。開発環境のCognito設定を確認してください。',
  })
  useEffect(() => {
    if (!auth) return
    let active = true
    const unsubscribe = auth.subscribe(() => setState(auth.getSnapshot()))
    configureApiAuthentication({ getToken: auth.getAccessToken, requireToken: auth.config.mode === 'cognito',
      onUnauthorized: auth.expire, onForbidden: auth.deny })
    void auth.initialize().then(() => { if (active) setState(auth.getSnapshot()) }).catch(() => {
      if (active) setState({ status: 'error', message: '認証を開始できませんでした。ページを開き直してください。' })
    })
    return () => { active = false; unsubscribe() }
  }, [auth])
  if (state.status === 'authenticated' && auth) {
    return <AuthContext.Provider value={{ mode: auth.config.mode, logout: () => auth.logout() }}>{children}</AuthContext.Provider>
  }
  return <><header><span className="brand">◈ Repo Sentinel</span><span className="local-badge">開発環境</span></header>
    <main><section className="card login-card"><h1>Repo Sentinelにログイン</h1>
      <p>本人用アカウントと認証アプリでログインしてください。</p>
      {state.message && <p role="alert" className="error">{state.message}</p>}
      {state.status === 'loading' ? <p role="status">認証を確認しています…</p>
        : state.status === 'denied' ? <button onClick={() => { void auth?.logout() }}>ログアウト</button>
          : <button disabled={!auth} onClick={() => { void auth?.login() }}>ログイン</button>}
    </section></main></>
}
