import { useEffect, useState } from 'react'
import { RequestError } from './api'

export function usePolling<T>(load: (signal: AbortSignal) => Promise<T>, shouldPoll: (value: T) => boolean) {
  const [data, setData] = useState<T>()
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let failures = 0
    async function poll() {
      try {
        const value = await load(controller.signal)
        if (controller.signal.aborted) return
        setData(value)
        setError('')
        failures = 0
        if (shouldPoll(value)) timer = setTimeout(() => { void poll() }, 2500)
      } catch (cause) {
        if (controller.signal.aborted) return
        failures += 1
        const retryable = !(cause instanceof RequestError) || cause.status === 0 || cause.status >= 500
        if (retryable && failures < 3) timer = setTimeout(() => { void poll() }, 2500)
        else setError(cause instanceof Error ? cause.message : '通信に失敗しました。')
      }
    }
    void poll()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [load, shouldPoll, revision])
  return { data, error, retry: () => { setRevision((value) => value + 1) } }
}
