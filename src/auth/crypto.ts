import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

// AES-256-GCM for OAuth token encryption at rest. TOKEN_ENCRYPTION_KEY must
// be a long random secret set via env — never derive it from a guessable
// value, and never rely on the dev fallback outside local development.
const KEY = scryptSync(process.env.TOKEN_ENCRYPTION_KEY ?? 'dev-only-insecure-key', 'seenpaid-salt', 32)

export function encryptToken(plaintext: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', KEY, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64')
}

export function decryptToken(encoded: string): string {
  const raw = Buffer.from(encoded, 'base64')
  const iv = raw.subarray(0, 12)
  const authTag = raw.subarray(12, 28)
  const ciphertext = raw.subarray(28)
  const decipher = createDecipheriv('aes-256-gcm', KEY, iv)
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}
