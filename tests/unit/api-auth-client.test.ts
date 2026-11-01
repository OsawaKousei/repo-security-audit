import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { configureApiAuthentication, createAudit, getHealth } from '../../frontend/app/src/api'

const auth = () => ({ getToken: async (): Promise<string | undefined> => 'access-token-for-test', requireToken: true, onUnauthorized: vi.fn(), onForbidden: vi.fn() })
afterEach(() => { vi.unstubAllGlobals(); configureApiAuthentication({ ...auth(), getToken: async () => undefined }) })
describe('authenticated API requests', () => {
  it('forwards only the access token and hashes the exact serialized POST body', async () => {
    configureApiAuthentication(auth())
    const fetch = vi.fn(async () => Response.json({ jobId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', status: 'PENDING' }, { status: 202 }))
    vi.stubGlobal('fetch', fetch)
    await createAudit('https://github.com/example/project')
    const [path, options] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(path).toBe('/api/audits')
    const headers = new Headers(options.headers)
    expect(headers.get('X-Access-Token')).toBe('access-token-for-test')
    expect(headers.has('Authorization')).toBe(false)
    expect(headers.get('X-Amz-Content-Sha256')).toBe(createHash('sha256').update(options.body as string).digest('hex'))
  })
  it('does not contact the API without a token', async () => {
    configureApiAuthentication({ ...auth(), getToken: async () => undefined })
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(getHealth(new AbortController().signal)).rejects.toMatchObject({ status: 401 })
    expect(fetch).not.toHaveBeenCalled()
  })
  it.each([401, 403])('notifies the auth gate of %s even with a non-JSON response', async (status) => {
    const config = auth()
    configureApiAuthentication(config)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status })))
    await expect(getHealth(new AbortController().signal)).rejects.toMatchObject({ status })
    expect(status === 401 ? config.onUnauthorized : config.onForbidden).toHaveBeenCalledTimes(1)
  })
})
