import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const directory = new URL('../../infra/terraform/modules/frontend/', import.meta.url)
function execute(file: string, event: unknown) {
  const source = readFileSync(new URL(file, directory), 'utf8')
  return runInNewContext(`${source}\nhandler(event)`, { event }, { timeout: 1000 })
}
describe('CloudFront viewer request functions', () => {
  it.each(['/', '/auth/callback', '/audits/example'])('serves the SPA shell for navigation %s', (uri) => {
    expect(execute('spa.js', { request: { uri } })).toEqual({ uri: '/index.html' })
  })
  it.each(['/assets/index-abc.js', '/favicon.svg'])('preserves static file path %s', (uri) => {
    expect(execute('spa.js', { request: { uri } })).toEqual({ uri })
  })
  it('fails API requests closed when the AWS runtime has not been deployed', () => {
    const response = execute('api-unavailable.js', { request: { uri: '/api/audits', method: 'POST' } })
    expect(response.statusCode).toBe(503)
    expect(response.headers['cache-control'].value).toBe('no-store')
    expect(JSON.parse(response.body)).toMatchObject({ error: { code: 'RUNTIME_NOT_DEPLOYED' } })
  })
})
