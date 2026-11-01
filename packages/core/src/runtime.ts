import { z } from 'zod'
import { cognitoSubSchema } from './auth.js'

export const auditMessageSchema = z.object({
  version: z.literal(1),
  jobId: z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/),
  ownerSub: cognitoSubSchema,
}).strict()
export const AI_BUDGET = { monthlyMicroUsd: 10_000_000, reservationMicroUsd: 50_000, dailyAiCalls: 5 } as const
export const AWS_LEASE = { pendingMs: 900_000, runningMs: 210_000 } as const
