import type { Db } from './db/index.ts'

// Long-polls (PLAN.md phase 3, D5): a request that waits until what it asks
// about has happened, or its time is up. A member's snapshot waits for the next
// log entry; the coordinator's batch waits for its window to close.
//
// One wait per key (a member of a room, a room's coordinator): a newer one
// under the same key ends the older at once, so each member holds one open
// request, well under a quick tunnel's 200 in flight.

// A wait answers within this, so a member's next request renews their presence
// (ONLINE_MS, 30 s) in time, and tunnels and proxies never time it out.
export const MAX_WAIT_MS = 25_000

// What a wait's check says: true, ready; false, look again after the next
// commit; a number, look again after that many milliseconds or the next
// commit, whichever comes first (a batching window closes on time alone).
export type Readiness = boolean | number

export type Waits = {
  // Resolves true once `check` says ready, false when `ms` ran out or a newer
  // wait took the key. `check` runs at once, after each commit and when it asked.
  until(key: string, ms: number, check: () => Readiness): Promise<boolean>
}

export function createWaits(db: Db): Waits {
  const current = new Map<string, () => void>()

  return {
    until: (key, ms, check) =>
      new Promise<boolean>(resolve => {
        current.get(key)?.()
        const deadline = Date.now() + ms
        let timer: ReturnType<typeof setTimeout> | undefined
        let isOver = false
        const finish = (isReady: boolean) => {
          if (isOver) return
          isOver = true
          clearTimeout(timer)
          stop()
          if (current.get(key) === supersede) current.delete(key)
          resolve(isReady)
        }
        const supersede = () => finish(false)
        const look = () => {
          if (isOver) return
          const answer = check()
          if (answer === true) return finish(true)
          const left = deadline - Date.now()
          if (left <= 0) return finish(false)
          clearTimeout(timer)
          timer = setTimeout(look, typeof answer === 'number' ? Math.min(Math.max(1, answer), left) : left)
        }
        const stop = db.onCommit(look)
        current.set(key, supersede)
        look()
      }),
  }
}
