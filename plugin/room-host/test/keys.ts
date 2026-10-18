// SSH keys and `ssh-keygen -Y sign` signatures made with node:crypto, so the
// join tests need no ssh-keygen. sshsig.spec.ts checks the verifier against
// real ssh-keygen output; this helper is checked against the verifier.

import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import type { KeyObject } from 'node:crypto'

const MAGIC = Buffer.from('SSHSIG')

function sshString(value: Buffer | string): Buffer {
  const body = typeof value === 'string' ? Buffer.from(value) : value
  const length = Buffer.alloc(4)
  length.writeUInt32BE(body.length)
  return Buffer.concat([length, body])
}

export type TestKey = {
  // As github.com/<login>.keys lists it.
  line: string
  sign: (message: string, namespace?: string) => string
}

export function ed25519Key(): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const x = Buffer.from((publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url')
  const blob = Buffer.concat([sshString('ssh-ed25519'), sshString(x)])
  return {
    line: `ssh-ed25519 ${blob.toString('base64')}`,
    sign: (message, namespace = 'studio-join') => armor(blob, privateKey, message, namespace),
  }
}

function armor(publicBlob: Buffer, privateKey: KeyObject, message: string, namespace: string): string {
  const digest = createHash('sha512').update(message).digest()
  const signed = Buffer.concat([MAGIC, sshString(namespace), sshString(''), sshString('sha512'), sshString(digest)])
  const signature = Buffer.concat([sshString('ssh-ed25519'), sshString(sign(null, signed, privateKey))])
  const version = Buffer.alloc(4)
  version.writeUInt32BE(1)
  const body = Buffer.concat([
    MAGIC, version, sshString(publicBlob), sshString(namespace), sshString(''), sshString('sha512'), sshString(signature),
  ]).toString('base64')
  const lines = body.match(/.{1,70}/g) ?? []
  return ['-----BEGIN SSH SIGNATURE-----', ...lines, '-----END SSH SIGNATURE-----', ''].join('\n')
}
