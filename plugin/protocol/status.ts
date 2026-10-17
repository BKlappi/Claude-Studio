// The room status: fixed keys, compact plain text (cheaper for models than
// JSON). See studio-mod-spec.md, "Status Format".
//
//   room: db-work | v12
//   doing: users table migration
//   touching: db/schema.sql, db/seed.sql
//   decided: users.email unique; soft delete via deleted_at
//   planned: rename orders.user → orders.user_id
//   blocked: -

export type RoomStatus = {
  room: string
  version: number
  doing: string
  touching: string[]
  decided: string[]
  planned: string[]
  blocked: string[]
}

const EMPTY = '-'

export function emptyStatus(room: string): RoomStatus {
  return { room, version: 0, doing: '', touching: [], decided: [], planned: [], blocked: [] }
}

export function formatStatus(status: RoomStatus): string {
  const list = (items: string[], separator: string) =>
    items.length === 0 ? EMPTY : items.join(separator)

  return [
    `room: ${status.room} | v${status.version}`,
    `doing: ${status.doing === '' ? EMPTY : status.doing}`,
    `touching: ${list(status.touching, ', ')}`,
    `decided: ${list(status.decided, '; ')}`,
    `planned: ${list(status.planned, '; ')}`,
    `blocked: ${list(status.blocked, '; ')}`,
  ].join('\n')
}

export function parseStatus(text: string): RoomStatus {
  const fields = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const colon = line.indexOf(':')
    if (colon === -1) continue
    fields.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim())
  }

  const split = (key: string, separator: string) => {
    const value = fields.get(key) ?? EMPTY
    if (value === EMPTY || value === '') return []
    return value.split(separator).map(part => part.trim()).filter(part => part !== '')
  }

  const header = fields.get('room') ?? ''
  const match = /^(.*?)\s*\|\s*v(\d+)$/.exec(header)
  const doing = fields.get('doing') ?? EMPTY

  return {
    room: match?.[1] ?? header,
    version: match?.[2] === undefined ? 0 : Number(match[2]),
    doing: doing === EMPTY ? '' : doing,
    touching: split('touching', ','),
    decided: split('decided', ';'),
    planned: split('planned', ';'),
    blocked: split('blocked', ';'),
  }
}

// The keys whose value changed between two versions, for "read only the
// changes since the last read".
export function changedKeys(before: RoomStatus, after: RoomStatus): (keyof RoomStatus)[] {
  const keys: (keyof RoomStatus)[] = ['doing', 'touching', 'decided', 'planned', 'blocked']
  return keys.filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
}
