import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'

export class HttpError extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 429

  constructor(status: HttpError['status'], message: string) {
    super(message)
    this.status = status
  }
}

export const fail = (status: HttpError['status'], message: string): never => {
  throw new HttpError(status, message)
}

export const now = () => Date.now()
export const newId = () => randomUUID()
export const randomToken = () => randomBytes(32).toString('base64url')
export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

// Compares two secrets in time that does not depend on where they differ.
export function sameSecret(given: string, expected: string): boolean {
  return timingSafeEqual(createHash('sha256').update(given).digest(), createHash('sha256').update(expected).digest())
}
