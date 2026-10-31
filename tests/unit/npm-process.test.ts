import { existsSync, readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { auditOutput, lockfile, manifest } from '../fixtures/worker.js'
const { execute } = vi.hoisted(() => ({ execute: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile: execute }))
import { runNpmAudit } from '../../workers/security-audit/app/src/npm-audit.js'
afterEach(() => execute.mockReset())
describe('isolated npm subprocess', () => {
  it('accepts vulnerability exit code, keeps secrets out of env, never installs and cleans up', async () => {
    let directory = ''
    execute.mockImplementation((command, args, options, callback) => {
      directory = options.cwd
      expect(command.endsWith('/npm')).toBe(true)
      expect(args.slice(0, 4)).toEqual(['audit', '--json', '--package-lock-only', '--ignore-scripts'])
      expect(options.shell).toBe(false)
      expect(options.env.OPENAI_API_KEY).toBeUndefined()
      expect(options.env.GITHUB_TOKEN).toBeUndefined()
      expect(JSON.parse(readFileSync(`${directory}/package.json`, 'utf8')).scripts).toBeUndefined()
      callback({ code: 1 }, JSON.stringify(auditOutput))
    })
    expect((await runNpmAudit(JSON.stringify(manifest), JSON.stringify(lockfile), new AbortController().signal)).summary.high).toBe(1)
    expect(existsSync(directory)).toBe(false)
  })
  it.each([
    [{ killed: true }, '', 'NPM_TIMEOUT'],
    [{ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, '', 'NPM_OUTPUT_TOO_LARGE'],
    [null, 'not json', 'NPM_INVALID_OUTPUT'],
    [{ code: 'ENOENT' }, '', 'NPM_FAILED'],
  ])('handles process failure and cleans up %j', async (error, output, code) => {
    let directory = ''
    execute.mockImplementation((_command, _args, options, callback) => { directory = options.cwd; callback(error, output) })
    await expect(runNpmAudit(JSON.stringify(manifest), JSON.stringify(lockfile), new AbortController().signal)).rejects.toMatchObject({ code })
    expect(existsSync(directory)).toBe(false)
  })
})
