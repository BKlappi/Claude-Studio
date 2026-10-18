// What /room invite says to the host person: the link, and what the person
// they send it to does with it (PLAN.md §5, "Onboarding").

import type { EngineInterface } from 'claude-code'
import { inviteLink } from '../protocol/join'
import type { Invite } from '../protocol/join'
import { getHosting } from './state'

// Where the plugin installs from, as `<owner>/<repo>` (the repo holds
// .claude-plugin/marketplace.json). Today the test repo; change it, and the
// README's install line, before the plugin is published. null: no install
// line in invites.
export const MARKETPLACE: string | null = 'BKlappi/Claude-Studio'

export const installLine = (): string | null => (MARKETPLACE === null ? null : `/plugin install studio --marketplace ${MARKETPLACE}`)

// The invite as the host person reads it, link included.
export async function inviteText($: EngineInterface, invite: Invite): Promise<string> {
  const hosting = await getHosting($)
  const install = installLine()
  return [
    'Invite link:',
    inviteLink(invite),
    '',
    'Whoever gets it runs /room join with it. The first time, that also links their GitHub login and an SSH key GitHub lists for it.',
    ...(install === null ? [] : [`Without Studio yet, they install it first: ${install}`]),
    ...(invite.roomKey === null ? [] : ['The link carries the private room\'s key: share it like a password.']),
    ...(hosting?.warning == null ? [] : [`Note: ${hosting.warning}`]),
  ].join('\n')
}
