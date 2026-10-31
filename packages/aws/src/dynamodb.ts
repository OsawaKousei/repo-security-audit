import { CreateTableCommand, DescribeTableCommand, DynamoDBClient, waitUntilTableExists } from '@aws-sdk/client-dynamodb'
import { setTimeout as delay } from 'node:timers/promises'
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { AuditError, auditSchema, jobIdSchema, machineResultSchema, type Audit, type AuditStore, type MachineResult } from '@repo-sentinel/core'

const key = (ownerSub: string, jobId: string) => ({ PK: `USER#${ownerSub}`, SK: `AUDIT#${jobId}` })
const lockKey = { PK: 'SYSTEM', SK: 'ACTIVE_AUDIT' }
const isConditionalFailure = (error: unknown) => error instanceof Error && error.name === 'ConditionalCheckFailedException'

export function dynamoClient(endpoint: string) {
  return new DynamoDBClient({
    endpoint, region: 'ap-northeast-1', credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
    maxAttempts: 3,
  })
}
export async function ensureTable(client: DynamoDBClient, tableName: string) {
  try {
    // DynamoDB Local may still be starting when Compose starts the API.
    for (let attempt = 0; ; attempt++) {
      try {
        await client.send(new DescribeTableCommand({ TableName: tableName }))
        break
      } catch (error) {
        if (error instanceof Error && error.name === 'ResourceNotFoundException') throw error
        if (attempt >= 14) throw error
        await delay(1000)
      }
    }
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'ResourceNotFoundException') throw error
    try {
      await client.send(new CreateTableCommand({
        TableName: tableName, BillingMode: 'PAY_PER_REQUEST',
        KeySchema: [{ AttributeName: 'PK', KeyType: 'HASH' }, { AttributeName: 'SK', KeyType: 'RANGE' }],
        AttributeDefinitions: [{ AttributeName: 'PK', AttributeType: 'S' }, { AttributeName: 'SK', AttributeType: 'S' }],
      }))
    } catch (createError) {
      if (!(createError instanceof Error) || createError.name !== 'ResourceInUseException') throw createError
    }
  }
  await waitUntilTableExists({ client, maxWaitTime: 30, minDelay: 1 }, { TableName: tableName })
}

export class DynamoAuditStore implements AuditStore {
  private db: DynamoDBDocumentClient
  constructor(client: DynamoDBClient, private tableName: string) {
    this.db = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } })
  }
  async create(ownerSub: string, audit: Audit) {
    const now = Date.now()
    try {
      await this.db.send(new TransactWriteCommand({ TransactItems: [
        { Update: {
          TableName: this.tableName, Key: { PK: `USER#${ownerSub}`, SK: `USAGE#${audit.createdAt.slice(0, 10)}` },
          UpdateExpression: 'ADD #count :one', ConditionExpression: 'attribute_not_exists(#count) OR #count < :limit',
          ExpressionAttributeNames: { '#count': 'count' }, ExpressionAttributeValues: { ':one': 1, ':limit': 5 },
        } },
        { Put: {
          TableName: this.tableName, Item: { ...lockKey, ownerSub, jobId: audit.jobId, leaseUntil: now + 180_000 },
          ConditionExpression: 'attribute_not_exists(jobId)',
        } },
        { Put: {
          TableName: this.tableName, Item: { ...key(ownerSub, audit.jobId), audit: auditSchema.parse(audit) },
          ConditionExpression: 'attribute_not_exists(PK)',
        } },
      ] }))
    } catch (error) {
      const reasons = (error as { CancellationReasons?: { Code?: string }[] }).CancellationReasons
      if (reasons?.[0]?.Code === 'ConditionalCheckFailed') throw new AuditError('DAILY_LIMIT', '本日の監査上限（5回）に達しました。', 429)
      if (reasons?.[1]?.Code === 'ConditionalCheckFailed') throw new AuditError('AUDIT_IN_PROGRESS', '実行中の監査が完了してから開始してください。', 409)
      throw error
    }
  }
  async get(ownerSub: string, jobId: string) {
    const result = await this.db.send(new GetCommand({ TableName: this.tableName, Key: key(ownerSub, jobId), ConsistentRead: true }))
    return result.Item ? auditSchema.parse(result.Item.audit) : undefined
  }
  async list(ownerSub: string, limit: number, cursor?: string) {
    let lastId: string | undefined
    if (cursor) {
      try { lastId = jobIdSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString())) }
      catch { throw new AuditError('INVALID_CURSOR', '履歴の継続トークンが不正です。', 400) }
    }
    const result = await this.db.send(new QueryCommand({
      TableName: this.tableName, KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': `USER#${ownerSub}`, ':prefix': 'AUDIT#' },
      ScanIndexForward: false, Limit: limit, ConsistentRead: true,
      ExclusiveStartKey: lastId ? key(ownerSub, lastId) : undefined,
    }))
    return {
      items: (result.Items ?? []).map((item) => auditSchema.parse(item.audit)),
      ...(result.LastEvaluatedKey ? { nextCursor: Buffer.from(JSON.stringify(result.LastEvaluatedKey.SK.slice(6))).toString('base64url') } : {}),
    }
  }
  async claim(ownerSub: string, jobId: string) {
    try {
      const result = await this.db.send(new UpdateCommand({
        TableName: this.tableName, Key: key(ownerSub, jobId),
        UpdateExpression: 'SET audit.#status = :running, audit.startedAt = :now, audit.attemptCount = audit.attemptCount + :one',
        ConditionExpression: 'audit.#status = :pending',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':running': 'RUNNING', ':pending': 'PENDING', ':now': new Date().toISOString(), ':one': 1 },
        ReturnValues: 'ALL_NEW',
      }))
      return auditSchema.parse(result.Attributes!.audit)
    } catch (error) {
      if (isConditionalFailure(error)) return undefined
      throw error
    }
  }
  async finish(ownerSub: string, audit: Audit) {
    auditSchema.parse(audit)
    if (audit.status !== 'COMPLETED' && audit.status !== 'FAILED') throw new Error('Terminal state required.')
    if (Buffer.byteLength(JSON.stringify(audit)) > 350 * 1024) throw new AuditError('RESULT_TOO_LARGE', '監査結果の保存上限を超えました。', 413)
    try {
      await this.db.send(new TransactWriteCommand({ TransactItems: [
        { Update: {
          TableName: this.tableName, Key: key(ownerSub, audit.jobId), UpdateExpression: 'SET audit = :audit',
          ConditionExpression: audit.status === 'FAILED' ? 'audit.#status IN (:running, :pending)' : 'audit.#status = :running',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':audit': audit, ':running': 'RUNNING', ...(audit.status === 'FAILED' ? { ':pending': 'PENDING' } : {}) },
        } },
        { Delete: {
          TableName: this.tableName, Key: lockKey, ConditionExpression: 'jobId = :id AND ownerSub = :owner',
          ExpressionAttributeValues: { ':id': audit.jobId, ':owner': ownerSub },
        } },
      ] }))
      return true
    } catch (error) {
      if (error instanceof Error && error.name === 'TransactionCanceledException' &&
          (error as { CancellationReasons?: { Code?: string }[] }).CancellationReasons?.some((r) => r.Code === 'ConditionalCheckFailed')) return false
      throw error
    }
  }
  async active() {
    const { Item } = await this.db.send(new GetCommand({ TableName: this.tableName, Key: lockKey, ConsistentRead: true }))
    return Item ? { ownerSub: Item.ownerSub as string, jobId: Item.jobId as string, leaseUntil: Item.leaseUntil as number } : undefined
  }
  async saveMachine(ownerSub: string, jobId: string, machine: MachineResult) {
    machineResultSchema.parse(machine)
    if (Buffer.byteLength(JSON.stringify(machine)) > 250 * 1024) throw new AuditError('RESULT_TOO_LARGE', '機械監査結果が保存上限を超えました。', 413)
    return this.updateRunning(ownerSub, jobId, 'SET audit.machine = :machine', { ':machine': machine })
  }
  async beginAi(ownerSub: string, jobId: string, model: string, attemptedAt: string) {
    return this.updateRunning(ownerSub, jobId,
      'SET audit.aiModel = :model, audit.aiAttemptedAt = :at', { ':model': model, ':at': attemptedAt },
      ' AND attribute_not_exists(audit.aiAttemptedAt)')
  }
  private async updateRunning(ownerSub: string, jobId: string, expression: string, values: Record<string, unknown>, condition = '') {
    try {
      await this.db.send(new UpdateCommand({
        TableName: this.tableName, Key: key(ownerSub, jobId), UpdateExpression: expression,
        ConditionExpression: `audit.#status = :running${condition}`,
        ExpressionAttributeNames: { '#status': 'status' }, ExpressionAttributeValues: { ...values, ':running': 'RUNNING' },
      }))
      return true
    } catch (error) { if (isConditionalFailure(error)) return false; throw error }
  }
}
