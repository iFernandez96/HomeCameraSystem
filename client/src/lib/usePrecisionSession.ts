import { useEffect, useState } from 'react'
import { getRecoverStatus, setCameraFocusMode } from './api'
import { errFields, log } from './log'

export type PrecisionSessionState = 'starting' | 'ready' | 'blocked'

const wait = () => new Promise((resolve) => window.setTimeout(resolve, 1000))

export function usePrecisionSession() {
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<PrecisionSessionState>('starting')
  const [detail, setDetail] = useState('Checking Jetson memory and temperature…')

  useEffect(() => {
    let mounted = true
    let precisionActive = false
    let stopSent = false

    const stop = async () => {
      if (stopSent) return
      stopSent = true
      for (let attempt = 0; attempt < 75; attempt += 1) {
        try {
          await setCameraFocusMode(false)
          return
        } catch (error) {
          // Exposure apply owns the same serialized host-action slot. If the
          // user leaves while it is finishing, wait for that exact action
          // instead of abandoning precision mode until the five-minute guard.
          if ((error as { status?: number }).status === 409) {
            await wait()
            continue
          }
          log.warn('precisionSession:stop-failed', errFields(error))
          return
        }
      }
      log.warn('precisionSession:stop-timeout', { attempts: 75 })
    }

    const start = async () => {
      try {
        const handle = await setCameraFocusMode(true)
        for (let poll = 0; poll < 90; poll += 1) {
          await wait()
          const status = await getRecoverStatus(handle.request_id)
          if (status.status === 'done') {
            precisionActive = true
            if (mounted) {
              setState('ready')
              setDetail('Guarded 1440p30 preview is active.')
            } else {
              await stop()
            }
            return
          }
          if (status.status === 'failed' || status.status === 'expired') {
            const reasons = status.result?.preflight?.reasons
            const reason = reasons?.length
              ? reasons.join('; ')
              : status.detail ?? 'The Jetson could not safely start precision mode.'
            if (mounted) {
              setState('blocked')
              setDetail(reason)
            }
            return
          }
        }
        if (mounted) {
          setState('blocked')
          setDetail('The camera did not confirm precision mode within 90 seconds.')
        }
      } catch (error) {
        log.warn('precisionSession:start-failed', errFields(error))
        if (mounted) {
          setState('blocked')
          setDetail('Precision mode is unavailable while another camera operation is running.')
        }
      } finally {
        if (!mounted && precisionActive) await stop()
      }
    }

    void start()
    return () => {
      mounted = false
      if (precisionActive) void stop()
    }
  }, [attempt])

  const retry = () => {
    setState('starting')
    setDetail('Checking Jetson memory and temperature…')
    setAttempt((value) => value + 1)
  }

  return { state, detail, retry }
}
