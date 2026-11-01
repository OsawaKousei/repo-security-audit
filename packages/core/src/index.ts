import { z } from 'zod'
export * from './auth.js'
export * from './runtime.js'

// Reject credentials, query strings, encoded paths and non-repository GitHub URLs.
const owner = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?'
const repositoryPattern = new RegExp(`^https://github\\.com/${owner}/[A-Za-z0-9_.-]{1,100}/?$`)
export const repositoryUrlSchema = z.string().trim().max(256).regex(
  repositoryPattern, 'https://github.com/owner/repository 形式で入力してください。',
).refine((value) => {
  const name = value.replace(/\/$/, '').split('/').at(-1)!.replace(/\.git$/, '')
  return name !== '' && name !== '.' && name !== '..'
}, 'リポジトリ名が不正です。')
export function repositoryFromUrl(value: string) {
  return repositoryUrlSchema.parse(value).replace(/\/$/, '').replace(/\.git$/, '').slice('https://github.com/'.length)
}
export const createAuditSchema = z.object({ repositoryUrl: repositoryUrlSchema }).strict()
export const jobIdSchema = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/)
export const statusSchema = z.enum(['PENDING', 'RUNNING', 'COMPLETED', 'FAILED'])
export const severitySchema = z.enum(['critical', 'high', 'moderate', 'low', 'info'])
export const summarySchema = z.object({
  critical: z.number().int().nonnegative(), high: z.number().int().nonnegative(),
  moderate: z.number().int().nonnegative(), low: z.number().int().nonnegative(),
  info: z.number().int().nonnegative(),
}).strict()
export const findingSchema = z.object({
  package: z.string(), title: z.string(), severity: severitySchema,
  range: z.string(), fixAvailable: z.boolean(), advisoryUrl: z.url(),
  fixVersion: z.string().nullable().optional(),
  fixPackage: z.string().nullable().optional(), fixIsSemVerMajor: z.boolean().optional(),
  advisories: z.array(z.object({ title: z.string(), url: z.url(), severity: severitySchema, range: z.string() }).strict()).optional(),
  viaPackages: z.array(z.string()).optional(),
}).strict()
export const reportSchema = z.object({
  overallAssessment: z.string(), summary: z.string(), priorities: z.array(z.string()),
  impacts: z.array(z.string()), recommendations: z.array(z.string()), limitations: z.array(z.string()),
}).strict()
export const failureCodeSchema = z.enum([
  'MOCK_FAILURE', 'DISPATCH_FAILED', 'JOB_TIMEOUT', 'RESULT_TOO_LARGE', 'WORKER_FAILED',
  'GITHUB_NOT_FOUND', 'GITHUB_PRIVATE', 'GITHUB_RATE_LIMIT', 'GITHUB_FAILED', 'GITHUB_TIMEOUT',
  'FILE_MISSING', 'FILE_TOO_LARGE', 'UNSUPPORTED_PROJECT', 'INVALID_LOCKFILE',
  'NPM_TIMEOUT', 'NPM_OUTPUT_TOO_LARGE', 'NPM_FAILED', 'NPM_INVALID_OUTPUT',
  'AI_INPUT_TOO_LARGE', 'AI_BUDGET_LIMIT', 'AI_ALREADY_ATTEMPTED', 'AI_BUDGET_UNAVAILABLE',
  'AI_NOT_CONFIGURED', 'AI_TIMEOUT', 'AI_REQUEST_FAILED', 'AI_OUTCOME_UNKNOWN',
  'AI_REFUSED', 'AI_INCOMPLETE', 'AI_INVALID_OUTPUT', 'AI_UNGROUNDED_OUTPUT', 'MODE_MISMATCH',
])
const machineFields = {
  commitSha: z.string().regex(/^[0-9a-f]{40}$/), summary: summarySchema, findings: z.array(findingSchema),
}
export const machineResultSchema = z.object(machineFields).strict()
export type MachineResult = z.infer<typeof machineResultSchema>
const base = {
  jobId: jobIdSchema, repository: z.string(), mode: z.enum(['mock', 'audit']),
  aiMode: z.enum(['mock', 'openai']).optional(),
  aiAttemptedAt: z.iso.datetime().optional(), aiModel: z.string().optional(),
  createdAt: z.iso.datetime(), attemptCount: z.number().int().nonnegative(),
}
export const auditSchema = z.discriminatedUnion('status', [
  z.object({ ...base, status: z.literal('PENDING') }).strict(),
  z.object({ ...base, status: z.literal('RUNNING'), startedAt: z.iso.datetime(), machine: machineResultSchema.optional() }).strict(),
  z.object({
    ...base, status: z.literal('COMPLETED'), startedAt: z.iso.datetime(), finishedAt: z.iso.datetime(),
    ...machineFields, report: reportSchema,
  }).strict(),
  z.object({
    ...base, status: z.literal('FAILED'), startedAt: z.iso.datetime().optional(),
    finishedAt: z.iso.datetime(), errorCode: failureCodeSchema, machine: machineResultSchema.optional(),
  }).strict(),
])
export const createAuditResponseSchema = z.object({ jobId: jobIdSchema, status: z.literal('PENDING') }).strict()
export const healthSchema = z.object({ status: z.literal('ok'), service: z.string(), mode: z.enum(['mock', 'audit']), aiMode: z.enum(['mock', 'openai']), execution: z.enum(['local', 'sqs']).optional() }).strict()
export const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20), cursor: z.string().max(256).optional(),
}).strict()
export const historyResponseSchema = z.object({ items: z.array(auditSchema), nextCursor: z.string().optional() }).strict()
export const errorResponseSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) })
export type Audit = z.infer<typeof auditSchema>
export type CompletedAudit = Extract<Audit, { status: 'COMPLETED' }>
export type FailureCode = z.infer<typeof failureCodeSchema>
export type History = z.infer<typeof historyResponseSchema>
export const isActive = (audit: Audit) => audit.status === 'PENDING' || audit.status === 'RUNNING'

export class AuditError extends Error {
  code: string
  status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 503
  constructor(code: string, message: string, status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 503) {
    super(message)
    this.code = code
    this.status = status
  }
}
export interface AuditStore {
  create(ownerSub: string, audit: Audit): Promise<void>
  get(ownerSub: string, jobId: string): Promise<Audit | undefined>
  list(ownerSub: string, limit: number, cursor?: string): Promise<History>
  claim(ownerSub: string, jobId: string): Promise<Audit | undefined>
  finish(ownerSub: string, audit: Audit, expectedStatus?: 'PENDING' | 'RUNNING'): Promise<boolean>
  active(): Promise<{ ownerSub: string; jobId: string; leaseUntil: number } | undefined>
  saveMachine(ownerSub: string, jobId: string, machine: MachineResult): Promise<boolean>
  beginAi(ownerSub: string, jobId: string, model: string, attemptedAt: string): Promise<boolean>
}
