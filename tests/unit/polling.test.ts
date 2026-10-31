// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePolling } from '../../frontend/app/src/use-polling'
import { RequestError } from '../../frontend/app/src/api'

const active = (status: string) => status === 'RUNNING' || status === 'PENDING'
async function flush() { await act(async () => { await Promise.resolve() }) }
async function advance(ms = 2500) { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
beforeEach(() => vi.useFakeTimers())
afterEach(() => { cleanup(); vi.useRealTimers() })
describe('polling lifecycle', () => {
  it.each(['COMPLETED', 'FAILED'])('polls every 2.5 seconds and stops on %s', async (terminal) => {
    const load = vi.fn().mockResolvedValueOnce('PENDING').mockResolvedValueOnce('RUNNING').mockResolvedValue(terminal)
    const { result } = renderHook(() => usePolling(load, active))
    await flush()
    await advance(2499)
    expect(load).toHaveBeenCalledTimes(1)
    await advance(1)
    expect(result.current.data).toBe('RUNNING')
    await advance()
    expect(result.current.data).toBe(terminal)
    await advance(10_000)
    expect(load).toHaveBeenCalledTimes(3)
  })
  it('aborts in-flight requests and removes the timer on navigation', async () => {
    const load = vi.fn().mockResolvedValue('RUNNING')
    const { unmount } = renderHook(() => usePolling(load, active))
    await flush()
    const signal = load.mock.calls[0][0] as AbortSignal
    unmount()
    expect(signal.aborted).toBe(true)
    await advance(10_000)
    expect(load).toHaveBeenCalledTimes(1)
  })
  it('stops after three communication failures and supports manual retry', async () => {
    const load = vi.fn().mockRejectedValue(new Error('offline'))
    const { result } = renderHook(() => usePolling(load, active))
    await flush()
    await advance()
    await advance()
    expect(result.current.error).toBe('offline')
    await advance(10_000)
    expect(load).toHaveBeenCalledTimes(3)
    load.mockResolvedValue('COMPLETED')
    await act(async () => { result.current.retry() })
    expect(result.current.data).toBe('COMPLETED')
    expect(result.current.error).toBe('')
  })
  it('does not retry a missing or unauthorized job', async () => {
    const load = vi.fn().mockRejectedValue(new RequestError('not found', 404))
    const { result } = renderHook(() => usePolling(load, active))
    await flush()
    await advance(10_000)
    expect(result.current.error).toBe('not found')
    expect(load).toHaveBeenCalledTimes(1)
  })
})
