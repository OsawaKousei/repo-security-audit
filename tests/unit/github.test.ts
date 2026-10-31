import { describe, expect, it, vi } from 'vitest'
import { fetchRepository } from '../../workers/security-audit/app/src/github.js'
import { boundedText } from '../../workers/security-audit/app/src/http.js'
import { LIMITS } from '../../workers/security-audit/app/src/limits.js'

const sha = 'a'.repeat(40), treeSha = 'b'.repeat(40), packageSha = 'c'.repeat(40), lockSha = 'd'.repeat(40)
function github(options: { private?: boolean; mode?: string; missing?: boolean; size?: number; blob?: string } = {}) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input))
    if (url.pathname === '/repos/example/project') return Response.json({ private: options.private ?? false, default_branch: 'main/test' })
    if (url.pathname.includes('/commits/')) return Response.json({ sha, commit: { tree: { sha: treeSha } } })
    if (url.pathname.includes('/git/trees/')) return Response.json({ truncated: false, tree: [
      { path: 'package.json', type: 'blob', mode: options.mode ?? '100644', sha: packageSha, size: options.size ?? 2 },
      ...(!options.missing ? [{ path: 'package-lock.json', type: 'blob', mode: '100644', sha: lockSha, size: 2 }] : []),
    ] })
    return new Response(options.blob ?? '{}')
  })
}
describe('GitHub snapshot retrieval', () => {
  it('pins both files to the commit tree and sends credentials only to the fixed API host', async () => {
    const fetcher = github()
    const files = await fetchRepository('example/project', new AbortController().signal, { token: 'test-token', fetch: fetcher })
    expect(files).toEqual({ commitSha: sha, packageJson: '{}', packageLock: '{}' })
    const urls = fetcher.mock.calls.map(([input]) => String(input))
    expect(urls).toContain(`https://api.github.com/repos/example/project/commits/main%2Ftest`)
    expect(urls).toContain(`https://api.github.com/repos/example/project/git/trees/${treeSha}`)
    expect(urls.slice(-2)).toEqual([`https://api.github.com/repos/example/project/git/blobs/${packageSha}`, `https://api.github.com/repos/example/project/git/blobs/${lockSha}`])
    expect(fetcher.mock.calls.every(([input, init]) => new URL(String(input)).hostname === 'api.github.com' && init?.redirect === 'error')).toBe(true)
  })
  it.each([
    [{ private: true }, 'GITHUB_PRIVATE'], [{ mode: '120000' }, 'UNSUPPORTED_PROJECT'],
    [{ missing: true }, 'FILE_MISSING'], [{ size: LIMITS.packageBytes + 1 }, 'FILE_TOO_LARGE'],
  ] as const)('rejects unsupported repository data %j', async (options, code) => {
    await expect(fetchRepository('example/project', new AbortController().signal, { fetch: github(options) })).rejects.toMatchObject({ code })
  })
  it.each([[404, 'GITHUB_NOT_FOUND'], [403, 'GITHUB_RATE_LIMIT'], [500, 'GITHUB_FAILED']] as const)('maps HTTP %i without exposing response bodies', async (status, code) => {
    await expect(fetchRepository('example/project', new AbortController().signal, { fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response('sensitive upstream body', { status })) })).rejects.toMatchObject({ code })
  })
  it('rejects a forged stored identifier before any request', async () => {
    const fetcher = github()
    await expect(fetchRepository('evil.example/a/b', new AbortController().signal, { fetch: fetcher })).rejects.toThrow()
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('bounds streamed bodies even without Content-Length', async () => {
    await expect(boundedText(new Response('x'.repeat(100)), 50, 'FILE_TOO_LARGE')).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' })
  })
})
