import { LOCAL_OWNER } from '@repo-sentinel/aws'

// Validate Host and browser Origin. Forwarded headers are deliberately not trusted.
export function isLocalRequest(request: Request) {
  const url = new URL(request.url)
  if (!['localhost', '127.0.0.1', 'api'].includes(url.hostname)) return false
  const origin = request.headers.get('Origin')
  if (origin && !['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:3000', 'http://127.0.0.1:3000'].includes(origin)) return false
  return request.headers.get('Sec-Fetch-Site') !== 'cross-site'
}

export const authorizeLocal = (request: Request) => isLocalRequest(request) ? LOCAL_OWNER : undefined
