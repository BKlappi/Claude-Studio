import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { JOIN_NAMESPACE, joinMessage } from '../../protocol/join.ts'
import { githubKeys } from '../src/github.ts'
import type { Fetch } from '../src/github.ts'
import { fingerprint, keyBlob, verifySshSignature } from '../src/sshsig.ts'

// Signatures made by Windows' own OpenSSH 9.5 (CRLF lines) and Git for
// Windows' OpenSSH 10.2, over fixtures/sshsig/message.txt. Only public keys
// are kept.
const FIXTURES = new URL('./fixtures/sshsig/', import.meta.url)
const fixture = (name: string) => readFileSync(new URL(name, FIXTURES), 'utf8')
const KEYS = ['ed25519', 'rsa', 'ecdsa256', 'ecdsa384', 'ecdsa521']
const MESSAGE = fixture('message.txt')

const check = (key: string, signature: string, overrides: Partial<Parameters<typeof verifySshSignature>[0]> = {}) =>
  verifySshSignature({
    armored: fixture(signature),
    message: MESSAGE,
    namespace: JOIN_NAMESPACE,
    allowedKeys: [fixture('stranger.pub'), fixture(`${key}.pub`)],
    ...overrides,
  })

test('the fixture message is the join message', () => {
  assert.equal(MESSAGE, joinMessage({
    roomId: '5f0c2a5e-1d2b-4c3a-9e8f-0123456789ab',
    origin: 'https://Quiet-River.trycloudflare.com/',
    login: 'octo-cat',
    nonce: 'q2V9mZ3xTt1u8aYbK0cR4w',
  }))
})

test('verifies every key type, signed by either ssh-keygen', () => {
  for (const key of KEYS) {
    for (const build of ['windows', 'git']) {
      const result = check(key, `${key}.${build}.sig`)
      const blob = keyBlob(fixture(`${key}.pub`))
      assert.ok(blob)
      assert.deepEqual(result, { ok: true, fingerprint: fingerprint(blob) }, `${key} by ${build}`)
    }
  }
})

test('refuses a changed message, another namespace, an unlisted key, junk', () => {
  const changed = MESSAGE.replace('nonce=q2V9', 'nonce=q2V8')
  assert.deepEqual(check('ed25519', 'ed25519.git.sig', { message: changed }), { ok: false, reason: 'signature does not match' })
  assert.deepEqual(check('ed25519', 'ed25519.other-namespace.sig'), { ok: false, reason: 'signature is for another namespace' })
  assert.deepEqual(
    check('ed25519', 'ed25519.git.sig', { allowedKeys: [fixture('stranger.pub'), fixture('rsa.pub')] }),
    { ok: false, reason: 'key is not one the GitHub account lists' },
  )
  assert.deepEqual(check('ed25519', 'ed25519.git.sig', { allowedKeys: [] }).ok, false)
  assert.deepEqual(verifySshSignature({ armored: 'hello', message: MESSAGE, namespace: JOIN_NAMESPACE, allowedKeys: [] }),
    { ok: false, reason: 'not an SSH signature' })
  const cut = fixture('ed25519.git.sig').replace(/\n[^\n]+\n-----END/, '\n-----END')
  assert.equal(check('ed25519', 'ed25519.git.sig', { armored: cut }).ok, false)
})

test('a key line with a mismatched type is not a key', () => {
  const [, base64] = fixture('ed25519.pub').split(' ')
  assert.equal(keyBlob(`ssh-rsa ${base64}`), null)
  assert.equal(keyBlob('not a key'), null)
  assert.ok(keyBlob(`${fixture('ed25519.pub').trim()} laptop@home`))
})

test('githubKeys reads both key lists and knows a missing account', async () => {
  const fake: Fetch = async url => {
    if (url === 'https://github.com/octo-cat.keys') return new Response('ssh-ed25519 AAAA1\nssh-rsa BBBB2\n')
    if (url === 'https://api.github.com/users/octo-cat/ssh_signing_keys') {
      return Response.json([{ id: 1, key: 'ssh-ed25519 CCCC3', title: 'signing' }, { id: 2, key: 'ssh-rsa BBBB2' }])
    }
    return new Response('Not Found', { status: 404 })
  }
  assert.deepEqual(await githubKeys('octo-cat', fake), ['ssh-ed25519 AAAA1', 'ssh-rsa BBBB2', 'ssh-ed25519 CCCC3'])
  assert.equal(await githubKeys('nobody-here', fake), null)
  assert.equal(await githubKeys('-bad-', fake), null)

  const limited: Fetch = async url =>
    url.endsWith('.keys') ? new Response('ssh-ed25519 AAAA1\n') : new Response('rate limited', { status: 403 })
  assert.deepEqual(await githubKeys('octo-cat', limited), ['ssh-ed25519 AAAA1'])
})

// The joiner's side as the mod runs it: the message on standard input, the
// signature on standard output. Runs where ssh-keygen is on PATH.
const hasSshKeygen = (() => {
  try {
    execFileSync('ssh-keygen', ['-?'], { stdio: 'ignore' })
    return true
  } catch (error) {
    return (error as { status?: number }).status !== undefined
  }
})()

test('round trip with this machine\'s ssh-keygen', { skip: !hasSshKeygen && 'ssh-keygen not on PATH' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'studio-sshsig-'))
  try {
    const key = join(dir, 'id_ed25519')
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'test', '-f', key])
    const message = joinMessage({ roomId: 'r1', origin: 'http://127.0.0.1:9', login: 'octo-cat', nonce: 'n1' })
    const armored = execFileSync('ssh-keygen', ['-Y', 'sign', '-n', JOIN_NAMESPACE, '-f', key], {
      input: message,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    const allowedKeys = [readFileSync(`${key}.pub`, 'utf8')]
    assert.equal(verifySshSignature({ armored, message, namespace: JOIN_NAMESPACE, allowedKeys }).ok, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
