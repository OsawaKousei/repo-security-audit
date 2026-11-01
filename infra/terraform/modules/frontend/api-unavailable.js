/* exported handler */
function handler() {
  return {
    statusCode: 503,
    statusDescription: 'Service Unavailable',
    headers: {
      'content-type': { value: 'application/json; charset=utf-8' },
      'cache-control': { value: 'no-store' },
    },
    body: JSON.stringify({ error: { code: 'RUNTIME_NOT_DEPLOYED', message: 'API runtime is not deployed.' } }),
  }
}
