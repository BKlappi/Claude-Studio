// The coordinator's batching window (PLAN.md §5): it reads the room's new
// messages once, not message by message, so people typing related requests
// within seconds of each other are merged, not answered one by one. Pure and
// shared: the host's mod times its step by it and the room host reports the
// remaining time to every pane.

export const BATCH_DEBOUNCE_MS = 4000
// The room setting: 2 to 30 s of quiet after the last message.
export const BATCH_DEBOUNCE_MIN_MS = 2000
export const BATCH_DEBOUNCE_MAX_MS = 30000
// The window never stays open longer than this many debounces after the
// first message (12 s for the default 4 s).
export const BATCH_CAP_DEBOUNCES = 3

export const clampDebounce = (ms: number): number =>
  Math.min(BATCH_DEBOUNCE_MAX_MS, Math.max(BATCH_DEBOUNCE_MIN_MS, Math.round(ms)))

// When the coordinator reads: `debounceMs` after the last unread message, but
// no later than `BATCH_CAP_DEBOUNCES` debounces after the first. `times` are
// the arrival times of the messages it has not read yet, in any order; null
// when there are none.
export function batchClosesAt(times: readonly number[], debounceMs: number = BATCH_DEBOUNCE_MS): number | null {
  if (times.length === 0) return null
  const debounce = clampDebounce(debounceMs)
  return Math.min(Math.max(...times) + debounce, Math.min(...times) + debounce * BATCH_CAP_DEBOUNCES)
}

// The same, as the snapshot carries it: milliseconds from `now`, at least 0.
export function batchWindow(times: readonly number[], now: number, debounceMs: number = BATCH_DEBOUNCE_MS): { closesInMs: number } | null {
  const closesAt = batchClosesAt(times, debounceMs)
  return closesAt === null ? null : { closesInMs: Math.max(0, closesAt - now) }
}
