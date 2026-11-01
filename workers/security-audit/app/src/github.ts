import { z } from 'zod'
import { AuditError, repositoryFromUrl } from '@repo-sentinel/core'
import { LIMITS } from './limits.js'
import { boundedText } from './http.js'

const sha = z.string().regex(/^[a-f0-9]{40}$/)
export interface RepositoryFiles { commitSha: string; packageJson: string; packageLock: string }
export async function fetchRepository(repository: string, signal: AbortSignal, options: { token?: string; fetch?: typeof fetch } = {}): Promise<RepositoryFiles> {
  // Revalidate stored identifiers before putting them into any URL.
  if (repositoryFromUrl(`https://github.com/${repository}`) !== repository) throw new AuditError('GITHUB_FAILED', 'リポジトリ識別子が不正です。', 400)
  const base = `https://api.github.com/repos/${repository}`
  async function get(path: string, maxBytes = 256 * 1024, raw = false) {
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(LIMITS.githubRequestMs)])
    try {
      const response = await (options.fetch ?? fetch)(`${base}${path}`, {
        signal: requestSignal, redirect: 'error',
        headers: {
          Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Repo-Sentinel-Local',
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        },
      })
      if (!response.ok) {
        await response.body?.cancel()
        const code = response.status === 404 ? 'GITHUB_NOT_FOUND' : [403, 429].includes(response.status) ? 'GITHUB_RATE_LIMIT' : 'GITHUB_FAILED'
        throw new AuditError(code, 'GitHubから対象データを取得できませんでした。', 503)
      }
      return await boundedText(response, maxBytes, 'FILE_TOO_LARGE', requestSignal)
    } catch (error) {
      if (error instanceof AuditError) throw error
      throw new AuditError(requestSignal.aborted ? 'GITHUB_TIMEOUT' : 'GITHUB_FAILED', 'GitHub通信に失敗しました。', 503)
    }
  }
  try {
    const meta = z.object({ private: z.boolean(), default_branch: z.string().min(1).max(256) }).parse(JSON.parse(await get('')))
    if (meta.private) throw new AuditError('GITHUB_PRIVATE', '公開リポジトリだけを監査できます。', 400)
    const commit = z.object({ sha, commit: z.object({ tree: z.object({ sha }) }) }).parse(JSON.parse(await get(`/commits/${encodeURIComponent(meta.default_branch)}`)))
    const tree = z.object({ truncated: z.boolean(), tree: z.array(z.object({ path: z.string(), mode: z.string(), type: z.string(), sha, size: z.number().optional() })) }).parse(JSON.parse(await get(`/git/trees/${commit.commit.tree.sha}`)))
    if (tree.truncated) throw new AuditError('UNSUPPORTED_PROJECT', 'ルートツリーが大きすぎます。', 400)
    async function file(name: string, maxBytes: number) {
      const entry = tree.tree.find((item) => item.path === name)
      if (!entry) throw new AuditError('FILE_MISSING', 'ルートのpackage.jsonとpackage-lock.jsonが必要です。', 400)
      if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) throw new AuditError('UNSUPPORTED_PROJECT', '対象ファイルのリンクやディレクトリは監査できません。', 400)
      if (entry.size === undefined || entry.size > maxBytes) throw new AuditError('FILE_TOO_LARGE', '対象ファイルがサイズ上限を超えました。', 413)
      return get(`/git/blobs/${entry.sha}`, maxBytes, true)
    }
    const [packageJson, packageLock] = await Promise.all([file('package.json', LIMITS.packageBytes), file('package-lock.json', LIMITS.lockBytes)])
    return { commitSha: commit.sha, packageJson, packageLock }
  } catch (error) {
    if (error instanceof AuditError) throw error
    throw new AuditError('GITHUB_FAILED', 'GitHubの応答形式が不正です。', 503)
  }
}
