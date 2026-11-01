import { auditMessageSchema, type AuditStore } from '@repo-sentinel/core'

export type SqsRecord = { messageId: string; body: string; eventSource: string; eventSourceARN: string }
export type SqsEvent = { Records: SqsRecord[] }
export type LambdaTime = { getRemainingTimeInMillis(): number }

export function createSqsHandler(options: {
  store: AuditStore & { expireStaleAudit(ownerSub: string): Promise<void> }
  queueArn: string; ownerSub: string; aiMode: 'mock' | 'openai'
  runAudit: (jobId: string, ownerSub: string, context?: LambdaTime) => Promise<void>
  log?: (event: { event: string; code?: string }) => void
}) {
  const log = options.log ?? ((event) => console.log(JSON.stringify(event)))
  return async (event: SqsEvent, context?: LambdaTime) => {
    if (!Array.isArray(event?.Records) || !event.Records.length || event.Records.length > 10 ||
      event.Records.some((record) => !record || typeof record.messageId !== 'string' || !record.messageId)) throw new Error('Invalid SQS envelope.')
    const batchItemFailures: { itemIdentifier: string }[] = []
    for (const record of event.Records) {
      try {
        if (context && context.getRemainingTimeInMillis() < 15_000) throw new Error('Insufficient invocation time.')
        if (record.eventSource !== 'aws:sqs' || record.eventSourceARN !== options.queueArn || typeof record.body !== 'string' ||
          Buffer.byteLength(record.body) > 512) throw new Error('Invalid SQS source or body.')
        const message = auditMessageSchema.parse(JSON.parse(record.body))
        if (message.ownerSub !== options.ownerSub) throw new Error('Unapproved owner.')
        await options.store.expireStaleAudit(options.ownerSub)
        let audit = await options.store.get(message.ownerSub, message.jobId)
        if (!audit) throw new Error('Missing durable job.')
        if (audit.status === 'COMPLETED' || audit.status === 'FAILED') continue
        if (audit.mode !== 'audit' || audit.aiMode !== options.aiMode) throw new Error('Unexpected job mode.')
        if (audit.status === 'PENDING') await options.runAudit(message.jobId, message.ownerSub, context)
        audit = await options.store.get(message.ownerSub, message.jobId)
        // A duplicate of an in-flight job must stay queued, never claim again.
        if (!audit || (audit.status !== 'COMPLETED' && audit.status !== 'FAILED')) throw new Error('Job is not terminal.')
        if (audit.status === 'FAILED') {
          log({ event: 'AuditFailed', code: audit.errorCode })
          if (audit.errorCode.startsWith('AI_')) log({ event: 'AiFailed', code: audit.errorCode })
        }
      } catch {
        log({ event: 'WorkerRecordFailed' })
        batchItemFailures.push({ itemIdentifier: record.messageId })
      }
    }
    return { batchItemFailures }
  }
}
