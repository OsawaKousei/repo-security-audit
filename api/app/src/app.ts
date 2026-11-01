import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { AuditError, createAuditSchema, historyQuerySchema, jobIdSchema, repositoryFromUrl, type AuditStore } from '@repo-sentinel/core'
import { monotonicFactory } from 'ulid'

const nextId = monotonicFactory()
type Options = {
  store: AuditStore
  // Authentication is denied by default. Entry points supply a verified owner.
  authorize?: (request: Request) => string | undefined | Promise<string | undefined>
  enqueue?: (jobId: string, ownerSub: string) => Promise<void>
  mode?: 'mock' | 'audit'
  aiMode?: 'mock' | 'openai'
}
export function createApp({ store, authorize, enqueue = async () => {}, mode = 'mock', aiMode = 'mock' }: Options) {
  const app = new Hono<{ Variables: { ownerSub: string } }>()
  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store')
    const ownerSub = await authorize?.(c.req.raw)
    if (!ownerSub) return c.json({ error: { code: 'UNAUTHORIZED', message: '認証が必要です。' } }, 401)
    c.set('ownerSub', ownerSub)
    await next()
  })
  app.use('/api/*', bodyLimit({ maxSize: 4096, onError: (c) => c.json({ error: { code: 'BODY_TOO_LARGE', message: 'リクエストが大きすぎます。' } }, 413) }))
  app.get('/api/health', (c) => c.json({ status: 'ok', service: 'repo-sentinel-api', mode, aiMode }))
  app.post('/api/audits', async (c) => {
    if (!/^application\/json(?:\s*;|$)/i.test(c.req.header('Content-Type') ?? '')) {
      throw new AuditError('INVALID_INPUT', 'JSON形式で送信してください。', 400)
    }
    const input = createAuditSchema.safeParse(await c.req.json().catch(() => null))
    if (!input.success) throw new AuditError('INVALID_INPUT', 'GitHubリポジトリのURLを確認してください。', 400)
    const jobId = nextId()
    const ownerSub = c.get('ownerSub')
    await store.create(ownerSub, {
      jobId, repository: repositoryFromUrl(input.data.repositoryUrl), status: 'PENDING',
      createdAt: new Date().toISOString(), attemptCount: 0, mode, aiMode,
    })
    try { await enqueue(jobId, ownerSub) }
    catch {
      const audit = await store.get(ownerSub, jobId)
      if (audit?.status === 'PENDING') await store.finish(ownerSub, { ...audit, status: 'FAILED', finishedAt: new Date().toISOString(), errorCode: 'DISPATCH_FAILED' })
      throw new AuditError('DISPATCH_FAILED', '監査の開始に失敗しました。履歴を確認してください。', 503)
    }
    return c.json({ jobId, status: 'PENDING' as const }, 202)
  })
  app.get('/api/audits', async (c) => {
    const query = historyQuerySchema.safeParse(c.req.query())
    if (!query.success) throw new AuditError('INVALID_INPUT', '履歴の取得条件が不正です。', 400)
    return c.json(await store.list(c.get('ownerSub'), query.data.limit, query.data.cursor))
  })
  app.get('/api/audits/:id', async (c) => {
    const id = jobIdSchema.safeParse(c.req.param('id'))
    if (!id.success) throw new AuditError('INVALID_INPUT', 'ジョブIDが不正です。', 400)
    const audit = await store.get(c.get('ownerSub'), id.data)
    if (!audit) throw new AuditError('NOT_FOUND', '監査が見つかりません。', 404)
    return c.json(audit)
  })
  app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: 'APIが見つかりません。' } }, 404))
  app.onError((error, c) => {
    if (error instanceof AuditError) return c.json({ error: { code: error.code, message: error.message } }, error.status)
    console.error('API request failed.')
    return c.json({ error: { code: 'INTERNAL_ERROR', message: '処理に失敗しました。時間をおいて再試行してください。' } }, 500)
  })
  return app
}
