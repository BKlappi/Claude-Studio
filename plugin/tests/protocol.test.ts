// The pure parts of phase 3: branch names, the batching window, the countdown
// and the people line.

import { expect, test } from 'claude-code/testing'
import { needsApproval, runnableIds } from '../hooks/approval'
import { peopleLine } from '../hooks/pane'
import { countdownText } from '../hooks/summary'
import { roomSlug, taskBranch } from '../protocol/branch'
import { BATCH_DEBOUNCE_MS, batchClosesAt, batchWindow, clampDebounce } from '../protocol/batch'
import type { Task } from '../protocol/types'

test('a room name becomes a slug a branch can carry', () => {
  expect(roomSlug('Design Frontend')).toBe('design-frontend')
  expect(roomSlug('db work')).toBe('db-work')
  expect(roomSlug('Café_Ünï.v2')).toBe('cafe-uni-v2')
  expect(roomSlug('straße')).toBe('strasse')
  expect(roomSlug('  --x--  ')).toBe('x')
  // Nothing a branch can hold: a name all the same.
  expect(roomSlug('日本語')).toBe('room')
  const long = roomSlug('a'.repeat(39) + ' b' + ' c'.repeat(20))
  expect(long.length).toBeLessThanOrEqual(40)
  expect(long.endsWith('-')).toBe(false)
})

test('a task branch is studio/<room-slug>/<task-id>, whatever the names say', () => {
  const id = '3f2a9c1e-5b7d-4e0a-8c11-0d9f6b2a7e44'
  expect(taskBranch('frontend', id)).toBe(`studio/frontend/${id}`)
  expect(taskBranch('Design Frontend', 't3')).toBe('studio/design-frontend/t3')
  // Ids and names come from another machine and end up as git arguments.
  expect(taskBranch('x', '--upload-pack=evil')).toBe('studio/x/upload-pack-evil')
  expect(taskBranch('x', '../../etc/passwd')).toBe('studio/x/etc-passwd')
  expect(taskBranch('--x', 'a b;c')).toBe('studio/x/a-b-c')
  for (const [room, task] of [['a/b', 'c d'], ['..', '.lock'], ['~^:?*[', 'x\\y']] as const) {
    expect(taskBranch(room, task)).toMatch(/^studio\/[a-z0-9-]+\/[A-Za-z0-9-]+$/)
  }
  expect(() => taskBranch('frontend', '...')).toThrow()
})

test('the batching window: 4 s after the last message, never more than 12 s after the first', () => {
  expect(BATCH_DEBOUNCE_MS).toBe(4000)
  expect(batchClosesAt([])).toBeNull()
  expect(batchClosesAt([1000])).toBe(5000)
  expect(batchClosesAt([1000, 4000])).toBe(8000)
  // Typing never stops: the cap, 12 s after the first.
  expect(batchClosesAt([1000, 4000, 7000, 10000, 12500])).toBe(13000)
  // Any order.
  expect(batchClosesAt([4000, 1000])).toBe(8000)
  // The room's own setting: 2 to 30 s of quiet, and three times that at most.
  expect(batchClosesAt([1000, 3000, 5000, 7000], 2000)).toBe(7000)
  expect(clampDebounce(500)).toBe(2000)
  expect(clampDebounce(99999)).toBe(30000)
  expect(clampDebounce(4000)).toBe(4000)
})

test('the window the snapshot carries is the time left, never below zero', () => {
  expect(batchWindow([], 0)).toBeNull()
  expect(batchWindow([1000], 2000)).toEqual({ closesInMs: 3000 })
  expect(batchWindow([1000], 9000)).toEqual({ closesInMs: 0 })
})

test('the countdown counts from when the room host answered, on this side\'s clock', () => {
  const batch = { closesInMs: 3000 }
  expect(countdownText(null, 0, 0)).toBeNull()
  expect(countdownText(batch, null, 0)).toBeNull()
  expect(countdownText(batch, 10_000, 10_000)).toBe('coordinator reads in 3 s…')
  expect(countdownText(batch, 10_000, 10_500)).toBe('coordinator reads in 3 s…')
  expect(countdownText(batch, 10_000, 11_000)).toBe('coordinator reads in 2 s…')
  expect(countdownText(batch, 10_000, 12_999)).toBe('coordinator reads in 1 s…')
  expect(countdownText(batch, 10_000, 13_000)).toBe('coordinator is reading…')
})

test('the people line says who hosts, who would take over, and who is here now', () => {
  const member = (login: string, verified: boolean, isOnline: boolean) => ({
    login, role: 'member' as const, verified, joinedAt: 1, isOnline,
  })
  expect(peopleLine([member('ben', true, true), member('ana', true, false), member('cem', false, true), member('dee', true, true)], 'ben'))
    .toBe('ben (host, online), ana (successor 1, joined), cem (unverified, online), dee (successor 2, online)')
})

test('a task from someone else asks first; your own does not; an answer stands while the task is yours', () => {
  const task = (id: string, state: Task['state'], claimedBy: string | null, createdBy: string): Task => ({
    id, roomId: 'r1', title: id, spec: '', state, difficulty: null, claimedBy, createdBy, askedBy: [createdBy], createdAt: 1, updatedAt: 1, version: 1,
  })
  const theirs = task('a', 'claimed', 'ana', 'ben')
  expect(needsApproval(theirs, 'ana', {})).toBe(true)
  expect(needsApproval(theirs, 'ana', { a: 'later' })).toBe(false)
  expect(needsApproval(theirs, 'ana', { a: 'worktree' })).toBe(false)
  expect(needsApproval(theirs, 'cem', {})).toBe(false)
  expect(needsApproval(theirs, null, {})).toBe(false)
  expect(needsApproval(task('b', 'claimed', 'ana', 'ana'), 'ana', {})).toBe(false)
  expect(needsApproval(task('c', 'open', null, 'ben'), 'ana', {})).toBe(false)
  expect(needsApproval(task('d', 'done', 'ana', 'ben'), 'ana', {})).toBe(false)

  const all = [theirs, task('b', 'blocked', 'ana', 'ana'), task('c', 'open', null, 'ben'), task('d', 'done', 'ana', 'ben'), task('e', 'claimed', 'cem', 'ben')]
  expect(runnableIds(all, 'ana')).toEqual(['a', 'b'])
  expect(runnableIds(all, null)).toEqual([])
})
