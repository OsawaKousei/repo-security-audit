import { z } from 'zod'
import { auditSchema, createAuditResponseSchema, errorResponseSchema, healthSchema, historyResponseSchema } from '@repo-sentinel/core'
import { TOKEN_HEADER } from '@repo-sentinel/core'

let authentication = {
  getToken: async (): Promise<string | undefined> => undefined,
  requireToken: true,
  onUnauthorized: () => {},
  onForbidden: () => {},
}
export function configureApiAuthentication(value: typeof authentication) { authentication = value }

export class RequestError extends Error {
  status: number
  constructor(message: string, status = 0) { super(message); this.status = status }
}
async function request<T>(path: string, schema: z.ZodType<T>, options: RequestInit = {}): Promise<T> {
  const token = await authentication.getToken()
  if (authentication.requireToken && !token) throw new RequestError('ログインが必要です。', 401)
  const headers = new Headers(options.headers)
  if (token) headers.set(TOKEN_HEADER, token)
  if (typeof options.body === 'string') {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(options.body))
    headers.set('X-Amz-Content-Sha256', Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(''))
  }
  const response = await fetch(`/api${path}`, {
    ...options, headers,
    signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
  })
  if (response.status === 401) authentication.onUnauthorized()
  if (response.status === 403) authentication.onForbidden()
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const error = errorResponseSchema.safeParse(body)
    throw new RequestError(error.success ? error.data.error.message : 'APIへの接続に失敗しました。', response.status)
  }
  const result = schema.safeParse(body)
  if (!result.success) throw new RequestError('APIの応答形式が不正です。')
  return result.data
}
export const getAudit = (id: string, signal: AbortSignal) => request(`/audits/${encodeURIComponent(id)}`, auditSchema, { signal })
export const getHealth = (signal: AbortSignal) => request('/health', healthSchema, { signal })
export const getHistory = (cursor: string | undefined, signal: AbortSignal) => request(`/audits${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, historyResponseSchema, { signal })
export const createAudit = (repositoryUrl: string) => request('/audits', createAuditResponseSchema, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repositoryUrl }),
})
