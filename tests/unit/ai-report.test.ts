import { describe, expect, it, vi } from 'vitest'
import { machine, aiOutput } from '../fixtures/worker.js'
import { prepareAiRequest, requestAiReport, validateAiReport } from '../../workers/security-audit/app/src/ai-report.js'
import { AI_MODEL, LIMITS } from '../../workers/security-audit/app/src/limits.js'

const envelope = (output: unknown = aiOutput) => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] }] })
describe('grounded AI report', () => {
  it('inserts names, counts and fix versions from machine evidence', () => {
    const result = validateAiReport(aiOutput, machine)
    expect(result.summary).toContain('high 1')
    expect(result.priorities[0]).toContain('demo-lib')
    expect(result.recommendations[0]).toContain('parent-lib@3.0.0')
  })
  it.each([
    { priorities: [1] }, { priorities: [0, 0] }, { overallAssessment: 'no_known_vulnerabilities' },
    { summary: 'CVE-2099-1234が検出されました' }, { summary: '修正版は9.9.9です' },
    { summary: 'https://evil.exampleを確認' }, { recommendations: [] },
  ])('rejects unsupported claims %j', (override) => {
    expect(() => validateAiReport({ ...aiOutput, ...override }, machine)).toThrow()
  })
  it('uses bounded, strict Structured Outputs without tools or raw source content', () => {
    const body = JSON.parse(prepareAiRequest('example/project', new Date().toISOString(), machine))
    expect(body.model).toBe(AI_MODEL)
    expect(body.max_output_tokens).toBe(LIMITS.aiOutputTokens)
    expect(body.text.format.strict).toBe(true)
    expect(body.text.format.schema.additionalProperties).toBe(false)
    expect(body.tools).toBeUndefined()
    expect(body.store).toBe(false)
    expect(Object.keys(JSON.parse(body.input))).toEqual(['repository', 'commitSha', 'auditedAt', 'summary', 'findings'])
  })
  it('rejects oversized input before a request can be made', () => {
    const oversized = structuredClone(machine); oversized.findings[0].title = 'x'.repeat(33_000)
    expect(() => prepareAiRequest('example/project', new Date().toISOString(), oversized)).toThrow()
  })
  it('sends one Responses request and verifies the output', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(envelope()))
    await expect(requestAiReport('{}', machine, 'test-secret', new AbortController().signal, fetcher)).resolves.toMatchObject({ priorities: [expect.stringContaining('demo-lib')] })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][0]).toBe('https://api.openai.com/v1/responses')
    expect(fetcher.mock.calls[0][1]?.redirect).toBe('error')
  })
  it.each([
    [{ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'refused' }] }] }, 'AI_REFUSED'],
    [{ ...envelope(), status: 'incomplete' }, 'AI_INCOMPLETE'],
    [{}, 'AI_INVALID_OUTPUT'],
    [envelope({ ...aiOutput, priorities: [99] }), 'AI_UNGROUNDED_OUTPUT'],
  ])('records invalid/refused/incomplete output without retry', async (body, code) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body))
    await expect(requestAiReport('{}', machine, 'test-secret', new AbortController().signal, fetcher)).rejects.toMatchObject({ code })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('does not retry transport failures or leak API response bodies', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('transport error with sensitive headers'))
    await expect(requestAiReport('{}', machine, 'test-secret', new AbortController().signal, fetcher)).rejects.toMatchObject({ code: 'AI_OUTCOME_UNKNOWN' })
    expect(fetcher).toHaveBeenCalledTimes(1)
    const denied = vi.fn<typeof fetch>().mockResolvedValue(new Response('upstream secret', { status: 401 }))
    await expect(requestAiReport('{}', machine, 'test-secret', new AbortController().signal, denied)).rejects.toMatchObject({ code: 'AI_REQUEST_FAILED' })
  })
})
