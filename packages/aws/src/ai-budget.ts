import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, TransactWriteCommand } from '@aws-sdk/lib-dynamodb'
import { AI_BUDGET, AuditError, cognitoSubSchema, jobIdSchema } from '@repo-sentinel/core'

// Reservations are global per table, permanent, conservative, and never refunded.
export function createDynamoAiBudget(client: DynamoDBClient, tableName: string) {
  const db = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } })
  return async (ownerSub: string, jobId: string, now = new Date()) => {
    cognitoSubSchema.parse(ownerSub); jobIdSchema.parse(jobId)
    const at = now.toISOString()
    try {
      await db.send(new TransactWriteCommand({ TransactItems: [
        { Update: { TableName: tableName, Key: { PK: 'AI_BUDGET', SK: `DAY#${at.slice(0, 10)}` },
          UpdateExpression: 'ADD #calls :one', ConditionExpression: 'attribute_not_exists(#calls) OR #calls < :limit',
          ExpressionAttributeNames: { '#calls': 'calls' }, ExpressionAttributeValues: { ':one': 1, ':limit': AI_BUDGET.dailyAiCalls } } },
        { Update: { TableName: tableName, Key: { PK: 'AI_BUDGET', SK: `MONTH#${at.slice(0, 7)}` },
          UpdateExpression: 'ADD microUsd :cost', ConditionExpression: 'attribute_not_exists(microUsd) OR microUsd <= :max',
          ExpressionAttributeValues: { ':cost': AI_BUDGET.reservationMicroUsd, ':max': AI_BUDGET.monthlyMicroUsd - AI_BUDGET.reservationMicroUsd } } },
        { Put: { TableName: tableName, Item: { PK: `USER#${ownerSub}`, SK: `AI_RESERVATION#${jobId}`, at, microUsd: AI_BUDGET.reservationMicroUsd },
          ConditionExpression: 'attribute_not_exists(PK)' } },
        { ConditionCheck: { TableName: tableName, Key: { PK: `USER#${ownerSub}`, SK: `AUDIT#${jobId}` },
          ConditionExpression: 'audit.#status = :running AND attribute_exists(audit.aiAttemptedAt)',
          ExpressionAttributeNames: { '#status': 'status' }, ExpressionAttributeValues: { ':running': 'RUNNING' } } },
        { ConditionCheck: { TableName: tableName, Key: { PK: 'SYSTEM', SK: 'ACTIVE_AUDIT' },
          ConditionExpression: 'ownerSub = :owner AND jobId = :id AND leaseUntil > :now',
          ExpressionAttributeValues: { ':owner': ownerSub, ':id': jobId, ':now': now.getTime() } } },
      ] }))
    } catch (error) {
      const reasons = (error as { CancellationReasons?: { Code?: string }[] }).CancellationReasons
      if (reasons?.[2]?.Code === 'ConditionalCheckFailed') throw new AuditError('AI_ALREADY_ATTEMPTED', 'AI呼び出しは既に予約されています。', 409)
      if (reasons?.slice(0, 2).some((item) => item.Code === 'ConditionalCheckFailed')) throw new AuditError('AI_BUDGET_LIMIT', 'AIの日次・月次予算上限に達しました。', 429)
      throw new AuditError('AI_BUDGET_UNAVAILABLE', 'AI予算を安全に予約できません。呼び出しを停止しました。', 503)
    }
  }
}
