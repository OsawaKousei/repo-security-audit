import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { reserveAiBudget } from '../../workers/security-audit/app/src/ai-budget.js'
import { LIMITS } from '../../workers/security-audit/app/src/limits.js'

let directory: string
const today = new Date('2026-11-02T00:00:00Z')
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'repo-sentinel-budget-test-')) })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })
describe('durable AI spend reservations', () => {
  it('keeps daily limits across independent calls and never reserves the same job twice', async () => {
    const job = ulid()
    await reserveAiBudget(directory, 'user', job, today)
    await expect(reserveAiBudget(directory, 'user', job, today)).rejects.toMatchObject({ code: 'AI_ALREADY_ATTEMPTED' })
    for (let i = 0; i < 4; i++) await reserveAiBudget(directory, 'user', ulid(), today)
    await expect(reserveAiBudget(directory, 'user', ulid(), today)).rejects.toMatchObject({ code: 'AI_BUDGET_LIMIT' })
    expect(JSON.parse(await readFile(join(directory, 'budget.json'), 'utf8')).reservations).toHaveLength(5)
  })
  it('enforces the monthly boundary while allowing the next UTC month', async () => {
    const reservations = Array.from({ length: 199 }, () => ({ ownerSub: 'user', jobId: ulid(), at: '2026-11-01T00:00:00.000Z', microUsd: LIMITS.reservationMicroUsd }))
    await writeFile(join(directory, 'budget.json'), JSON.stringify({ version: 1, reservations }))
    await reserveAiBudget(directory, 'user', ulid(), today)
    await expect(reserveAiBudget(directory, 'user', ulid(), new Date('2026-11-03T00:00:00Z'))).rejects.toMatchObject({ code: 'AI_BUDGET_LIMIT' })
    await reserveAiBudget(directory, 'user', ulid(), new Date('2026-12-01T00:00:00Z'))
  })
  it('does not allow simultaneous writers to lose reservations', async () => {
    const results = await Promise.allSettled([reserveAiBudget(directory, 'user', ulid(), today), reserveAiBudget(directory, 'user', ulid(), today)])
    const successes = results.filter((r) => r.status === 'fulfilled').length
    expect(successes).toBeGreaterThan(0)
    expect(JSON.parse(await readFile(join(directory, 'budget.json'), 'utf8')).reservations).toHaveLength(successes)
    for (const result of results) if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'AI_BUDGET_UNAVAILABLE' })
  })
  it('fails closed on corruption or a stale lock', async () => {
    await writeFile(join(directory, 'budget.json'), 'corrupt')
    await expect(reserveAiBudget(directory, 'user', ulid(), today)).rejects.toMatchObject({ code: 'AI_BUDGET_UNAVAILABLE' })
    await rm(join(directory, 'budget.json'))
    await writeFile(join(directory, 'budget.lock'), '')
    await expect(reserveAiBudget(directory, 'user', ulid(), today)).rejects.toMatchObject({ code: 'AI_BUDGET_UNAVAILABLE' })
  })
})
