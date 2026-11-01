import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs'
import { auditMessageSchema } from '@repo-sentinel/core'

export function createAuditEnqueuer(client: Pick<SQSClient, 'send'>, queueUrl: string) {
  return async (jobId: string, ownerSub: string) => {
    const message = auditMessageSchema.parse({ version: 1, jobId, ownerSub })
    await client.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(message) }))
  }
}
