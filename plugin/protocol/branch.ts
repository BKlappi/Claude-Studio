// Branch names for the work a room does in the shared repo (PLAN.md D22, D23):
// one branch per claimed task, `studio/<room-slug>/<task-id>`.
//
// Names come from other machines (a room's name, a task id), and a branch name
// ends up as a git argument: only a-z, 0-9 and `-` get through, and the name
// always starts with `studio/`, never with a dash.

// "Design Frontend" → "design-frontend". Accents fall away; a name with no
// letter or digit a branch can hold (all CJK, say) becomes "room".
export function roomSlug(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return slug === '' ? 'room' : slug
}

// A branch name that is safe to hand to git as one argument: no leading
// dash, no `..`, no `@{`, no spaces or control characters, no `.lock` end.
// A room's base branch comes from another machine and is checked with this.
export function isBranchName(name: string): boolean {
  return /^(?!-)(?!.*\.\.)(?!.*@\{)(?!.*\/\/)[A-Za-z0-9._/-]{1,200}$/.test(name) && !/(^\/|\/$|\.lock$|\.$)/.test(name)
}

// `studio/design-frontend/3f2a…` (the task's whole id: it is what ties the
// branch to the task when the work is picked up or cleaned away).
export function taskBranch(roomName: string, taskId: string): string {
  const id = taskId.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (id === '') throw new Error('a task id with no letter or digit cannot name a branch')
  return `studio/${roomSlug(roomName)}/${id}`
}
