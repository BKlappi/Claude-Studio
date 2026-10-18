import { expect, test } from 'claude-code/testing'
import { tokenize } from '../hooks/commands'
import { mergeSnapshot } from '../hooks/sync'
import { projectPath } from '../hooks/tracking'
import { formatStatus, parseStatus } from '../protocol/status'
import type { RoomSnapshot } from '../protocol/types'

const PANE = {
  component: 'Pane',
  requestId: 'studio-room',
  props: {
    title: 'room',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

function snapshotOf(roomId: string, seqs: number[]): RoomSnapshot {
  return {
    room: { id: roomId, name: roomId, visibility: 'open', repoUrl: null, hostLogin: 'ben', createdAt: 0 },
    members: [],
    tasks: [],
    log: seqs.map(seq => ({
      seq, roomId, kind: 'message', author: 'ben', body: `#${seq}`, data: null, at: seq,
    })),
    statusText: '',
    batch: null,
    state: null,
    cursor: seqs.at(-1) ?? 0,
  }
}

test('tokenize keeps quoted room names together', () => {
  expect(tokenize('create "design frontend" --private')).toEqual(['create', 'design frontend', '--private'])
  expect(tokenize("join 'db work'")).toEqual(['join', 'db work'])
  expect(tokenize('')).toEqual([])
})

test('projectPath sends only paths inside the project, relative', () => {
  expect(projectPath('C:\\code\\app', 'C:\\code\\app\\db\\seed.sql')).toBe('db/seed.sql')
  expect(projectPath('C:\\code\\app', 'c:/Code/App/src/x.ts')).toBe('src/x.ts')
  expect(projectPath('/home/ben/app/', '/home/ben/app/src/x.ts')).toBe('src/x.ts')
  expect(projectPath('/home/ben/app', '/home/ben/.ssh/config')).toBeNull()
  expect(projectPath('/home/ben/app', '/home/ben/apple/x.ts')).toBeNull()
})

test('mergeSnapshot appends the log in one room and resets on another', () => {
  const first = mergeSnapshot(null, snapshotOf('a', [1, 2]))
  const second = mergeSnapshot(first, snapshotOf('a', [3]))
  expect(second.log.map(entry => entry.seq)).toEqual([1, 2, 3])
  expect(second.cursor).toBe(3)

  const other = mergeSnapshot(second, snapshotOf('b', [7]))
  expect(other.log.map(entry => entry.seq)).toEqual([7])
})

test('status format round-trips', () => {
  const text = 'room: ui | v3\ndoing: dark mode\ntouching: src/theme.ts\ndecided: -\nplanned: -\nblocked: -'
  expect(formatStatus(parseStatus(text))).toBe(text)
})

test('the room pane says how to get into a room when not in one', async $ => {
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'studio', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: /Not in a room/ })).toBeDefined()
    await ui.unmount()
  }
})
