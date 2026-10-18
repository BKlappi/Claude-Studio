// types/index.d.ts must be self-contained, so it mirrors protocol/types.ts.
// These assignments fail to type-check (`pnpm typecheck`) if either side
// changes without the other.

import { expect, test } from 'claude-code/testing'
import type { LogEntry, Member, PendingJoin, Room, RoomSnapshot, RoomState, Task } from '../protocol/types'
import type { LogEntryView, MemberView, PendingJoinView, RoomInfo, RoomStateView, RoomView, TaskView } from '../types'

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const same = <A, B>(isSame: Same<A, B>) => isSame

test('the state contract mirrors the wire types', () => {
  expect([
    same<Member, MemberView>(true),
    same<Room, RoomInfo>(true),
    same<Task, TaskView>(true),
    same<LogEntry, LogEntryView>(true),
    same<RoomSnapshot, RoomView>(true),
    same<PendingJoin, PendingJoinView>(true),
    same<RoomState, RoomStateView>(true),
  ]).toEqual([true, true, true, true, true, true, true])
})
