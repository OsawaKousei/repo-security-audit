import { z } from 'zod'
import { auditSchema, createAuditResponseSchema, errorResponseSchema, historyResponseSchema } from '@repo-sentinel/core'

export class RequestError extends Error {
  status: number
  constructor(message: string, status = 0) { super(message); this.status = status }
}
async function request<T>(path: string, schema: z.ZodType<T>, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
  })
  const body: unknown = await response.json()
  if (!response.ok) {
    const error = errorResponseSchema.safeParse(body)
    throw new RequestError(error.success ? error.data.error.message : 'APIへの接続に失敗しました。', response.status)
  }
  const result = schema.safeParse(body)
  if (!result.success) throw new RequestError('APIの応答形式が不正です。')
  return result.data
}
export const getAudit = (id: string, signal: AbortSignal) => request(`/audits/${encodeURIComponent(id)}`, auditSchema, { signal })
export const getHistory = (cursor: string | undefined, signal: AbortSignal) => request(`/audits${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, historyResponseSchema, { signal })
export const createAudit = (repositoryUrl: string) => request('/audits', createAuditResponseSchema, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repositoryUrl }),
})
