import { LOCAL_OWNER } from '@repo-sentinel/aws'

// Validate Host and browser Origin. Forwarded headers are deliberately not trusted.
export function authorizeLocal(request: Request) {
  const url = new URL(request.url)
  if (!['localhost', '127.0.0.1', 'api'].includes(url.hostname)) return undefined
  const origin = request.headers.get('Origin')
  if (origin && !['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:3000', 'http://127.0.0.1:3000'].includes(origin)) return undefined
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return undefined
  return LOCAL_OWNER
}
