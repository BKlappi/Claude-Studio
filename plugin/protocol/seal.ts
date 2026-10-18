// Sealing a private room's directory entry with its room key (PLAN.md D17):
// without the key its name, host and address cannot be read, and any change
// to the sealed text is detected.
//
// Built on SHA-256 alone, the one primitive both the mod's environment and
// Node offer (`crypto.subtle.digest`): HKDF-SHA256 (RFC 5869) derives two keys
// per room from the room key, HMAC-SHA256 (RFC 2104) in counter mode is the
// keystream, and an HMAC-SHA256 tag over nonce and ciphertext authenticates
// it (encrypt-then-MAC). The room host's tests check both primitives against
// node:crypto and the RFCs' test vectors.
//
//   sealed = "v1." + base64url(nonce[16] ‖ ciphertext ‖ tag[32])

const encoder = new TextEncoder()
const HMAC_BLOCK = 64
const NONCE_BYTES = 16
const TAG_BYTES = 32
const VERSION = 'v1.'

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', concat(parts)))
}

export async function hmacSha256(key: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const padded = new Uint8Array(HMAC_BLOCK)
  padded.set(key.length > HMAC_BLOCK ? await sha256(key) : key)
  const inner = padded.map(byte => byte ^ 0x36)
  const outer = padded.map(byte => byte ^ 0x5c)
  return sha256(outer, await sha256(inner, message))
}

export async function hkdfSha256(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  if (length > 255 * 32) throw new Error('hkdf: length too large')
  const prk = await hmacSha256(salt.length === 0 ? new Uint8Array(32) : salt, ikm)
  const blocks: Uint8Array[] = []
  let previous: Uint8Array = new Uint8Array(0)
  for (let counter = 1; blocks.length * 32 < length; counter++) {
    previous = await hmacSha256(prk, concat([previous, info, Uint8Array.of(counter)]))
    blocks.push(previous)
  }
  return concat(blocks).slice(0, length)
}

export function toBase64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// Throws on text that is not base64url.
export function fromBase64url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('not base64url')
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(binary, char => char.charCodeAt(0))
}

async function keysFor(roomKey: string, roomId: string) {
  const okm = await hkdfSha256(
    fromBase64url(roomKey),
    encoder.encode('studio-rooms'),
    encoder.encode(`directory entry v1 ${roomId}`),
    64,
  )
  return { encryption: okm.slice(0, 32), authentication: okm.slice(32) }
}

async function keystream(key: Uint8Array, nonce: Uint8Array, length: number): Promise<Uint8Array> {
  const blocks: Uint8Array[] = []
  for (let counter = 0; blocks.length * 32 < length; counter++) {
    const index = new Uint8Array(4)
    new DataView(index.buffer).setUint32(0, counter)
    blocks.push(await hmacSha256(key, concat([nonce, index])))
  }
  return concat(blocks).slice(0, length)
}

const xor = (data: Uint8Array, stream: Uint8Array) => data.map((byte, i) => byte ^ (stream[i] ?? 0))

// Constant time over equal lengths.
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let difference = 0
  for (let i = 0; i < a.length; i++) difference |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return difference === 0
}

// --- a room host proving it hosts the room (PLAN.md phase 3, handover) --------
//
// Members hold the room's secret; a room host at an address they do not know
// yet (a new host, a quick tunnel's new name) answers their nonce with
//
//   HMAC-SHA256(secret, "studio-host v1\nroom=<id>\norigin=<origin>\nnonce=<nonce>\n")
//
// The origin is the one the member dialled: a room host proves itself only for
// its own addresses, so a stranger relaying the challenge gets nothing usable.

export function hostProofMessage(challenge: { roomId: string; origin: string; nonce: string }): string {
  return `studio-host v1\nroom=${challenge.roomId}\norigin=${challenge.origin}\nnonce=${challenge.nonce}\n`
}

export async function hostProof(secret: string, challenge: { roomId: string; origin: string; nonce: string }): Promise<string> {
  return toBase64url(await hmacSha256(encoder.encode(secret), encoder.encode(hostProofMessage(challenge))))
}

export async function isHostProof(secret: string, challenge: { roomId: string; origin: string; nonce: string }, proof: string): Promise<boolean> {
  let given: Uint8Array
  try {
    given = fromBase64url(proof)
  } catch {
    return false
  }
  return sameBytes(given, fromBase64url(await hostProof(secret, challenge)))
}

// `text` sealed for the room: only someone holding `roomKey` reads it. The
// room id is bound in, so an entry cannot be moved to another room.
export async function seal(roomKey: string, roomId: string, text: string): Promise<string> {
  const keys = await keysFor(roomKey, roomId)
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
  const plain = encoder.encode(text)
  const cipher = xor(plain, await keystream(keys.encryption, nonce, plain.length))
  const tag = await hmacSha256(keys.authentication, concat([nonce, cipher]))
  return VERSION + toBase64url(concat([nonce, cipher, tag]))
}

// The text, or null when the key is wrong or the sealed text was changed.
export async function unseal(roomKey: string, roomId: string, sealed: string): Promise<string | null> {
  if (!sealed.startsWith(VERSION)) return null
  let bytes: Uint8Array
  let keys: Awaited<ReturnType<typeof keysFor>>
  try {
    bytes = fromBase64url(sealed.slice(VERSION.length))
    keys = await keysFor(roomKey, roomId)
  } catch {
    return null
  }
  if (bytes.length < NONCE_BYTES + TAG_BYTES) return null
  const nonce = bytes.slice(0, NONCE_BYTES)
  const cipher = bytes.slice(NONCE_BYTES, bytes.length - TAG_BYTES)
  const tag = bytes.slice(bytes.length - TAG_BYTES)
  if (!sameBytes(tag, await hmacSha256(keys.authentication, concat([nonce, cipher])))) return null
  try {
    return new TextDecoder('utf-8').decode(xor(cipher, await keystream(keys.encryption, nonce, cipher.length)))
  } catch {
    return null
  }
}
