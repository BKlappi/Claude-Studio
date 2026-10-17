import assert from 'node:assert/strict'
import { test } from 'node:test'
import { changedKeys, emptyStatus, formatStatus, parseStatus } from '../../plugin/protocol/status.ts'

const SPEC_EXAMPLE = `room: db-work | v12
doing: users table migration
touching: db/schema.sql, db/seed.sql
decided: users.email unique; soft delete via deleted_at
planned: rename orders.user → orders.user_id
blocked: -`

test('parses and formats the spec example losslessly', () => {
  const status = parseStatus(SPEC_EXAMPLE)
  assert.deepEqual(status, {
    room: 'db-work',
    version: 12,
    doing: 'users table migration',
    touching: ['db/schema.sql', 'db/seed.sql'],
    decided: ['users.email unique', 'soft delete via deleted_at'],
    planned: ['rename orders.user → orders.user_id'],
    blocked: [],
  })
  assert.equal(formatStatus(status), SPEC_EXAMPLE)
})

test('an empty status uses - for every empty key', () => {
  assert.equal(
    formatStatus(emptyStatus('ui')),
    'room: ui | v0\ndoing: -\ntouching: -\ndecided: -\nplanned: -\nblocked: -',
  )
})

test('changedKeys names only what changed', () => {
  const before = parseStatus(SPEC_EXAMPLE)
  const after = { ...before, version: 13, blocked: ['waiting on auth room'] }
  assert.deepEqual(changedKeys(before, after), ['blocked'])
})
