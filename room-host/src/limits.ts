// Fixed-window counters, in memory: how often something may happen per key
// within one window. Enough to keep the unauthenticated join routes from
// being used to hammer the host, or GitHub through it.

export function createLimiter(windowMs: number, now: () => number = Date.now) {
  const windows = new Map<string, { startedAt: number; count: number }>()

  // True, and counted, while `key` is under `max` in this window.
  function take(key: string, max: number): boolean {
    const at = now()
    const current = windows.get(key)
    if (current === undefined || at - current.startedAt >= windowMs) {
      // Spent windows go when the map grows, so it never holds many.
      if (windows.size >= 10_000) {
        for (const [name, window] of windows) if (at - window.startedAt >= windowMs) windows.delete(name)
      }
      windows.set(key, { startedAt: at, count: 1 })
      return true
    }
    if (current.count >= max) return false
    current.count += 1
    return true
  }

  return { take }
}
