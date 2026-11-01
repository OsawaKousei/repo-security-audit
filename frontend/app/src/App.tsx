import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { createAuditSchema, isActive, type Audit, type History } from '@repo-sentinel/core'
import { createAudit, getAudit, getHealth, getHistory } from './api'
import { usePolling } from './use-polling'
import './App.css'
import { useAuth } from './auth-context'

const labels = { PENDING: '待機中', RUNNING: '実行中', COMPLETED: '完了', FAILED: '失敗' }
const date = (value: string) => new Date(value).toLocaleString('ja-JP')
const pollHistory = (value: History) => value.items.some(isActive)
const noPolling = () => false
const machineOf = (audit?: Audit) => audit?.status === 'COMPLETED' ? audit : audit && 'machine' in audit ? audit.machine : undefined
const total = (audit: Audit) => { const machine = machineOf(audit); return machine ? Object.values(machine.summary).reduce((a, b) => a + b, 0) : '—' }
function Status({ audit }: { audit: Audit }) {
  return <span className={`status ${audit.status.toLowerCase()}`}>{labels[audit.status]}</span>
}
function ErrorNotice({ message, retry }: { message: string; retry?: () => void }) {
  return <div className="error" role="alert"><p>{message}</p>{retry && <button className="secondary" onClick={retry}>再取得する</button>}</div>
}
function AuditTable({ items }: { items: Audit[] }) {
  return <div className="table-wrap"><table><thead><tr><th>リポジトリ</th><th>監査日時</th><th>状態</th><th>検出件数</th></tr></thead>
    <tbody>{items.map((audit) => <tr key={audit.jobId}>
      <td><a href={`#/audits/${audit.jobId}`}>{audit.repository}</a></td>
      <td>{date(audit.createdAt)}</td><td><Status audit={audit} /></td><td>{total(audit)}</td>
    </tr>)}</tbody></table></div>
}
function StartAudit({ mode, execution }: { mode: 'mock' | 'audit'; execution?: 'local' | 'sqs' }) {
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const load = useCallback((signal: AbortSignal) => getHistory(undefined, signal), [])
  const history = usePolling(load, pollHistory)
  const active = history.data?.items.filter(isActive) ?? []
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (sending) return
    const input = createAuditSchema.safeParse({ repositoryUrl: url })
    if (!input.success) { setError(input.error.issues[0].message); return }
    setSending(true)
    setError('')
    try {
      const result = await createAudit(input.data.repositoryUrl)
      window.location.hash = `/audits/${result.jobId}`
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '監査を開始できませんでした。')
    } finally { setSending(false) }
  }
  return <>
    <div className="page-heading"><p className="eyebrow">REPOSITORY AUDIT</p><h1>依存関係のリスクを、見える形に。</h1><p>GitHubリポジトリを指定して、監査レポートの流れを確認できます。</p></div>
    <section className="card"><h2>新しい監査</h2><form onSubmit={(event) => { void submit(event) }}>
      {mode === 'audit' && <p className="notice">{execution === 'sqs' ? '実監査を開始します。完了するとレポートが表示されます。' : '実監査ジョブを作成します。作成後、表示されるジョブIDを使ってComposeのWorkerを直接実行してください。'}</p>}
      <label htmlFor="repository">GitHubリポジトリURL</label>
      <div className="form-row"><input id="repository" type="url" required value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://github.com/owner/repository" autoComplete="off" aria-describedby="repository-help" />
        <button type="submit" disabled={sending || active.length > 0}>{sending ? '開始しています…' : '監査を開始'}</button></div>
      <p id="repository-help" className="muted">公開リポジトリのルートにあるnpm依存関係が対象です。1日5回・同時1件まで。</p>
      {error && <ErrorNotice message={error} />}
    </form></section>
    <section className="card"><div className="section-heading"><h2>実行中の監査</h2><a href="#/audits">すべての履歴 →</a></div>
      {history.error ? <ErrorNotice message={history.error} retry={history.retry} /> : !history.data ? <p role="status">読み込み中…</p> : active.length ? <AuditTable items={active} /> : <p className="muted">実行中の監査はありません。</p>}
    </section>
  </>
}
function HistoryPage({ cursor }: { cursor?: string }) {
  const load = useCallback((signal: AbortSignal) => getHistory(cursor, signal), [cursor])
  const { data, error, retry } = usePolling(load, pollHistory)
  return <><div className="page-heading"><p className="eyebrow">AUDIT HISTORY</p><h1>監査履歴</h1><p>これまでの監査と処理状況を確認できます。</p></div>
    <section className="card">{error && <ErrorNotice message={error} retry={retry} />}
      {!data && !error && <p role="status">読み込み中…</p>}
      {data && (data.items.length ? <AuditTable items={data.items} /> : <p className="muted">監査履歴はまだありません。</p>)}
      <div className="pagination">{cursor && <a href="#/audits">最新の履歴へ</a>}{data?.nextCursor && <a href={`#/audits?cursor=${encodeURIComponent(data.nextCursor)}`}>次の20件 →</a>}</div>
    </section></>
}
function ReportList({ title, items }: { title: string; items: string[] }) {
  return <div><h3>{title}</h3><ul>{items.map((item, index) => <li key={index}>{item}</li>)}</ul></div>
}
function DetailPage({ id, execution }: { id: string; execution?: 'local' | 'sqs' }) {
  const load = useCallback((signal: AbortSignal) => getAudit(id, signal), [id])
  const { data: audit, error, retry } = usePolling(load, isActive)
  const machine = machineOf(audit)
  return <><div className="page-heading"><a href="#/audits">← 監査履歴</a><h1>監査結果</h1></div>
    {error && <ErrorNotice message={error} retry={retry} />}
    {!audit && !error && <p role="status">読み込み中…</p>}
    {audit && <>
      <section className="card"><div className="section-heading"><h2>{audit.repository}</h2><Status audit={audit} /></div>
        <dl><dt>監査日時</dt><dd>{date(audit.createdAt)}</dd><dt>ジョブID</dt><dd><code>{audit.jobId}</code></dd>
          <dt>監査種別</dt><dd>{audit.mode === 'audit' ? '実npm監査' : 'モック監査'}</dd>
          <dt>AI説明</dt><dd>{audit.aiMode === 'openai' ? 'OpenAI' : 'モック'}</dd>
          {'startedAt' in audit && audit.startedAt && <><dt>開始日時</dt><dd>{date(audit.startedAt)}</dd></>}
          {'finishedAt' in audit && <><dt>終了日時</dt><dd>{date(audit.finishedAt)}</dd></>}
          {machine && <><dt>対象コミット{audit.mode === 'mock' ? '（モック）' : ''}</dt><dd><code>{machine.commitSha}</code></dd></>}
        </dl>
        {isActive(audit) && <p className="progress" role="status">{audit.status === 'PENDING' ? '監査の開始を待っています。' : audit.mode === 'mock' ? 'モック監査を実行しています。' : '実際の依存関係を監査しています。'} 2.5秒ごとに更新します。</p>}
        {execution === 'local' && audit.mode === 'audit' && audit.status === 'PENDING' && <p><code>docker compose run --rm -e AUDIT_MODE=audit -e AI_MODE={audit.aiMode ?? 'mock'} worker npm run audit:local -w workers/security-audit/app -- {audit.jobId}</code></p>}
        {audit.status === 'FAILED' && <ErrorNotice message={`監査に失敗しました（${audit.errorCode}）。新しい監査を開始してください。`} />}
      </section>
      {machine && <section className="card"><h2>機械監査の検出結果{audit.mode === 'mock' ? '（モック）' : ''}</h2><p className="muted">{audit.mode === 'mock' ? 'サンプルデータです。実際のリポジトリから取得した検出結果ではありません。' : '対象コミットのルート依存関係に対するnpm auditの結果です。件数は脆弱性を持つパッケージ単位です。'}</p>
          <div className="severity-grid">{Object.entries(machine.summary).map(([severity, count]) => <div key={severity} className={`severity ${severity}`}><span>{severity}</span><strong>{count}</strong></div>)}</div>
          <div className="table-wrap"><table><thead><tr><th>パッケージ / 問題</th><th>深刻度</th><th>影響範囲</th><th>修正可否</th></tr></thead><tbody>{machine.findings.map((finding, index) => <tr key={index}>
            <td><strong>{finding.package}</strong><br /><a href={finding.advisoryUrl} target="_blank" rel="noreferrer">{finding.title}</a></td><td>{finding.severity}</td><td><code>{finding.range}</code></td><td>{finding.fixVersion ? `${finding.fixPackage}@${finding.fixVersion}${finding.fixIsSemVerMajor ? '（破壊的変更候補）' : ''}` : finding.fixAvailable ? '修正候補あり' : '要確認'}</td>
          </tr>)}</tbody></table></div>
        </section>}
      {audit.status === 'COMPLETED' && <>
        <section className="card report"><p className="eyebrow">AI EXPLANATION{audit.aiMode !== 'openai' ? ' · MOCK' : ''}</p><h2>AIレポート{audit.aiMode !== 'openai' ? '（モック）' : ''}</h2><p>{audit.report.overallAssessment}</p><h3>問題の概要</h3><p>{audit.report.summary}</p>
          <ReportList title="優先的に確認すべき問題" items={audit.report.priorities} /><ReportList title="想定される影響" items={audit.report.impacts} />
          <ReportList title="推奨される対応" items={audit.report.recommendations} /><ReportList title="監査の限界・注意事項" items={audit.report.limitations} />
        </section>
      </>}
    </>}
  </>
}
function App() {
  const auth = useAuth()
  const [hash, setHash] = useState(window.location.hash)
  const health = usePolling(getHealth, noPolling)
  useEffect(() => {
    const change = () => setHash(window.location.hash)
    window.addEventListener('hashchange', change)
    return () => window.removeEventListener('hashchange', change)
  }, [])
  const [path, query] = (hash.slice(1) || '/').split('?')
  const detail = /^\/audits\/([^/]+)$/.exec(path)
  return <><header><a className="brand" href="#/">◈ <span>Repo Sentinel</span></a><nav aria-label="メインナビゲーション"><a href="#/" aria-current={path === '/' ? 'page' : undefined}>監査を開始</a><a href="#/audits" aria-current={path.startsWith('/audits') ? 'page' : undefined}>監査履歴</a></nav><span className="local-badge">{auth.mode === 'cognito' ? '開発環境 · COGNITO' : health.data?.mode === 'audit' ? 'LOCAL AUDIT' : 'LOCAL MOCK'}</span>{auth.mode === 'cognito' && <button className="secondary logout" onClick={() => { void auth.logout() }}>ログアウト</button>}</header>
    <main><aside className="notice">監査開始の設定：{health.data?.mode === 'audit' ? health.data.execution === 'sqs' ? '実監査' : '実監査（Worker直接実行）' : 'ローカルモック'}。各レポートに実監査・モックとAI説明の種類を表示します。</aside>
      {health.error && <ErrorNotice message={health.error} retry={health.retry} />}
      {path === '/' ? health.data ? <StartAudit mode={health.data.mode} execution={health.data.execution} /> : !health.error && <p role="status">読み込み中…</p> : path === '/audits' ? <HistoryPage key={hash} cursor={new URLSearchParams(query).get('cursor') ?? undefined} /> : detail ? <DetailPage key={detail[1]} id={detail[1]} execution={health.data?.execution} /> : <ErrorNotice message="ページが見つかりません。" />}
    </main><footer>Repo Sentinel · Local development</footer></>
}
export default App
