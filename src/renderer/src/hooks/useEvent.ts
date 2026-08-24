import { useEffect, useRef } from 'react'

import type { AppEventMap, AppEventName } from '@shared/types/events'
import { bridge } from '@/lib/ipc'

/**
 * Subscribe a component to one main-process event.
 *
 * The handler is held in a ref so an inline arrow function does not tear the
 * subscription down and rebuild it on every render — which, on `message:delta`
 * at 30 events/second, would mean 30 unsubscribe/subscribe pairs a second.
 */
export function useAppEvent<K extends AppEventName>(
  name: K,
  handler: (payload: AppEventMap[K]) => void
): void {
  const ref = useRef(handler)
  ref.current = handler

  useEffect(() => {
    return bridge().events.on(name, (payload) => {
      ref.current(payload)
    })
  }, [name])
}
