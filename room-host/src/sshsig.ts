// Verifies `ssh-keygen -Y sign` signatures (OpenSSH's SSHSIG format) with
// node:crypto, so the room host needs no ssh-keygen of its own.
// Format: https://github.com/openssh/openssh-portable/blob/master/PROTOCOL.sshsig
//
// Supported keys: ssh-ed25519, ssh-rsa (rsa-sha2-256/512 signatures),
// ecdsa-sha2-nistp256/384/521. Security keys (sk-*) are refused: the host
// admits those people by hand.

import { createHash, createPublicKey, verify } from 'node:crypto'
import type { KeyObject } from 'node:crypto'

const MAGIC = Buffer.from('SSHSIG')
const ARMOR = /-----BEGIN SSH SIGNATURE-----([\s\S]*?)-----END SSH SIGNATURE-----/

export type SshSignature = {
  publicKey: Buffer
  namespace: string
  hashAlgorithm: string
  signature: Buffer
}

export type VerifyResult =
  | { ok: true; fingerprint: string }
  | { ok: false; reason: string }

class SshSigError extends Error {}

// SSH wire format: big-endian uint32 lengths before every string.
function reader(buffer: Buffer) {
  let at = 0
  const bytes = (length: number) => {
    if (at + length > buffer.length) throw new SshSigError('truncated')
    const out = buffer.subarray(at, at + length)
    at += length
    return out
  }
  const uint32 = () => bytes(4).readUInt32BE(0)
  const string = () => bytes(uint32())
  return { bytes, uint32, string, text: () => string().toString('utf8'), isDone: () => at === buffer.length }
}

function sshString(value: Buffer | string): Buffer {
  const body = typeof value === 'string' ? Buffer.from(value) : value
  const length = Buffer.alloc(4)
  length.writeUInt32BE(body.length)
  return Buffer.concat([length, body])
}

export function parseSignature(armored: string): SshSignature {
  const body = ARMOR.exec(armored)?.[1]
  if (body === undefined) throw new SshSigError('not an SSH signature')
  const blob = Buffer.from(body.replace(/\s+/g, ''), 'base64')
  const read = reader(blob)
  if (!read.bytes(MAGIC.length).equals(MAGIC)) throw new SshSigError('not an SSH signature')
  const version = read.uint32()
  if (version !== 1) throw new SshSigError(`signature version ${version}`)
  const publicKey = read.string()
  const namespace = read.text()
  read.string() // reserved
  const hashAlgorithm = read.text()
  const signature = read.string()
  if (!read.isDone()) throw new SshSigError('trailing bytes')
  return { publicKey, namespace, hashAlgorithm, signature }
}

// "ssh-ed25519 AAAA… comment" → the key's wire bytes; null for a line that is not a key.
export function keyBlob(line: string): Buffer | null {
  const [type, base64] = line.trim().split(/\s+/)
  if (!type || !base64) return null
  const blob = Buffer.from(base64, 'base64')
  try {
    return reader(blob).text() === type ? blob : null
  } catch {
    return null
  }
}

// As ssh-keygen -l prints it: SHA256:<base64, unpadded>.
export function fingerprint(blob: Buffer): string {
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`
}

const CURVES: Record<string, { crv: string; size: number; hash: string }> = {
  nistp256: { crv: 'P-256', size: 32, hash: 'sha256' },
  nistp384: { crv: 'P-384', size: 48, hash: 'sha384' },
  nistp521: { crv: 'P-521', size: 66, hash: 'sha512' },
}

// An mpint's digits, without the sign byte and leading zeros.
function digitsOf(mpint: Buffer): Buffer {
  let start = 0
  while (start < mpint.length - 1 && mpint[start] === 0) start++
  return mpint.subarray(start)
}

// An mpint as a fixed-width unsigned big-endian number.
function fixedWidth(mpint: Buffer, size: number): Buffer {
  const digits = digitsOf(mpint)
  if (digits.length > size) throw new SshSigError('number too long')
  return Buffer.concat([Buffer.alloc(size - digits.length), digits])
}

type PublicKey = { type: string; key: KeyObject; curve?: { size: number; hash: string } }

function publicKeyOf(blob: Buffer): PublicKey {
  const read = reader(blob)
  const type = read.text()
  if (type === 'ssh-ed25519') {
    const x = read.string().toString('base64url')
    return { type, key: createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' }) }
  }
  if (type === 'ssh-rsa') {
    const e = digitsOf(read.string()).toString('base64url')
    const n = digitsOf(read.string()).toString('base64url')
    return { type, key: createPublicKey({ key: { kty: 'RSA', e, n }, format: 'jwk' }) }
  }
  if (type.startsWith('ecdsa-sha2-')) {
    const name = read.text()
    const curve = CURVES[name]
    if (!curve || type !== `ecdsa-sha2-${name}`) throw new SshSigError(`unsupported key type ${type}`)
    const point = read.string()
    if (point[0] !== 4 || point.length !== 1 + 2 * curve.size) throw new SshSigError('bad curve point')
    const x = point.subarray(1, 1 + curve.size).toString('base64url')
    const y = point.subarray(1 + curve.size).toString('base64url')
    return { type, curve, key: createPublicKey({ key: { kty: 'EC', crv: curve.crv, x, y }, format: 'jwk' }) }
  }
  throw new SshSigError(`unsupported key type ${type}`)
}

function checkSignature(publicKey: PublicKey, data: Buffer, signatureBlob: Buffer): boolean {
  const read = reader(signatureBlob)
  const format = read.text()
  const raw = read.string()
  if (publicKey.type === 'ssh-ed25519') {
    return format === 'ssh-ed25519' && verify(null, data, publicKey.key, raw)
  }
  if (publicKey.type === 'ssh-rsa') {
    // SSHSIG forbids SHA-1 ("ssh-rsa") signatures.
    const hash = { 'rsa-sha2-256': 'sha256', 'rsa-sha2-512': 'sha512' }[format]
    return hash !== undefined && verify(hash, data, publicKey.key, raw)
  }
  if (publicKey.curve && format === publicKey.type) {
    const numbers = reader(raw)
    const { size, hash } = publicKey.curve
    const rs = Buffer.concat([fixedWidth(numbers.string(), size), fixedWidth(numbers.string(), size)])
    return verify(hash, data, { key: publicKey.key, dsaEncoding: 'ieee-p1363' }, rs)
  }
  return false
}

// True when `armored` is a signature of `message` in `namespace` by one of
// `allowedKeys` (lines as github.com/<login>.keys serves them).
export function verifySshSignature(input: {
  armored: string
  message: string
  namespace: string
  allowedKeys: readonly string[]
}): VerifyResult {
  try {
    const sig = parseSignature(input.armored)
    if (sig.namespace !== input.namespace) return { ok: false, reason: 'signature is for another namespace' }
    if (sig.hashAlgorithm !== 'sha256' && sig.hashAlgorithm !== 'sha512') {
      return { ok: false, reason: `hash ${sig.hashAlgorithm} not allowed` }
    }
    const isAllowed = input.allowedKeys.some(line => keyBlob(line)?.equals(sig.publicKey))
    if (!isAllowed) return { ok: false, reason: 'key is not one the GitHub account lists' }

    const publicKey = publicKeyOf(sig.publicKey)
    const digest = createHash(sig.hashAlgorithm).update(input.message).digest()
    const signed = Buffer.concat([
      MAGIC,
      sshString(sig.namespace),
      sshString(''),
      sshString(sig.hashAlgorithm),
      sshString(digest),
    ])
    return checkSignature(publicKey, signed, sig.signature)
      ? { ok: true, fingerprint: fingerprint(sig.publicKey) }
      : { ok: false, reason: 'signature does not match' }
  } catch (error) {
    if (error instanceof SshSigError) return { ok: false, reason: error.message }
    // node:crypto rejects malformed keys and signatures by throwing.
    return { ok: false, reason: 'malformed key or signature' }
  }
}
