import { AuditError } from '@repo-sentinel/core'

export async function boundedText(response: Response, maxBytes: number, oversized: string, signal?: AbortSignal) {
  if (Number(response.headers.get('Content-Length')) > maxBytes) {
    await response.body?.cancel()
    throw new AuditError(oversized, '応答サイズが上限を超えました。', 413)
  }
  const reader = response.body?.getReader()
  if (!reader) throw new AuditError('WORKER_FAILED', '応答本文がありません。', 500)
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      signal?.throwIfAborted()
      const result = await reader.read()
      if (result.done) break
      size += result.value.byteLength
      if (size > maxBytes) throw new AuditError(oversized, '応答サイズが上限を超えました。', 413)
      chunks.push(result.value)
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally { await reader.cancel().catch(() => {}) }
}
