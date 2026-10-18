// plugin/protocol/seal.ts runs in the mod, which has SHA-256 and nothing
// else; here its HMAC and HKDF are held to node:crypto and the RFCs.

import assert from 'node:assert/strict'
import { createHmac, hkdfSync, randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { fromBase64url, hkdfSha256, hmacSha256, seal, toBase64url, unseal } from '../../protocol/seal.ts'

const bytes = (hex: string) => new Uint8Array(Buffer.from(hex, 'hex'))
const hex = (data: Uint8Array) => Buffer.from(data).toString('hex')

test('HMAC-SHA256 matches node:crypto and RFC 4231', async () => {
  // RFC 4231, test case 2.
  assert.equal(
    hex(await hmacSha256(new TextEncoder().encode('Jefe'), new TextEncoder().encode('what do ya want for nothing?'))),
    '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
  )
  for (const keyLength of [0, 1, 32, 64, 65, 131]) {
    const key = randomBytes(keyLength)
    const message = randomBytes(keyLength * 3)
    assert.equal(hex(await hmacSha256(key, message)), createHmac('sha256', key).update(message).digest('hex'), `key of ${keyLength}`)
  }
})

test('HKDF-SHA256 matches node:crypto and RFC 5869', async () => {
  // RFC 5869, test case 1.
  const okm = await hkdfSha256(
    bytes('0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b'),
    bytes('000102030405060708090a0b0c'),
    bytes('f0f1f2f3f4f5f6f7f8f9'),
    42,
  )
  assert.equal(hex(okm), '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865')
  for (const length of [16, 32, 64, 100]) {
    const [ikm, salt, info] = [randomBytes(32), randomBytes(16), randomBytes(10)]
    assert.equal(hex(await hkdfSha256(ikm, salt, info, length)), Buffer.from(hkdfSync('sha256', ikm, salt, info, length)).toString('hex'))
  }
})

test('base64url round-trips and refuses other text', () => {
  const data = randomBytes(33)
  assert.equal(toBase64url(data), data.toString('base64url'))
  assert.deepEqual(fromBase64url(data.toString('base64url')), new Uint8Array(data))
  assert.throws(() => fromBase64url('a+b/'))
})

test('a sealed entry opens with its room key and room id only, and only unchanged', async () => {
  const roomKey = randomBytes(32).toString('base64url')
  const roomId = '5f0c2a5e-1d2b-4c3a-9e8f-0123456789ab'
  const text = JSON.stringify({ name: 'security fixes', host: 'ben', address: 'https://quiet-river.trycloudflare.com' })

  const sealed = await seal(roomKey, roomId, text)
  assert.match(sealed, /^v1\.[A-Za-z0-9_-]+$/)
  assert.doesNotMatch(sealed, /security|quiet-river|ben/)
  assert.notEqual(await seal(roomKey, roomId, text), sealed, 'a fresh nonce each time')
  assert.equal(await unseal(roomKey, roomId, sealed), text)

  assert.equal(await unseal(randomBytes(32).toString('base64url'), roomId, sealed), null)
  assert.equal(await unseal(roomKey, '00000000-0000-4000-8000-000000000000', sealed), null)
  const body = Buffer.from(sealed.slice(3), 'base64url')
  for (const at of [0, 20, body.length - 1]) {
    const changed = Buffer.from(body)
    changed[at] = (changed[at] ?? 0) ^ 1
    assert.equal(await unseal(roomKey, roomId, `v1.${changed.toString('base64url')}`), null, `byte ${at} changed`)
  }
  assert.equal(await unseal(roomKey, roomId, 'v2.abc'), null)
  assert.equal(await unseal(roomKey, roomId, 'v1.!!'), null)
  assert.equal(await unseal(roomKey, roomId, 'v1.'), null)
})
