import { createHmac, randomBytes } from 'node:crypto'

// OAuth 1.0a (HMAC-SHA1) request signing — used for X (Twitter) BYOK
// (Bring-Your-Own-Key) posting, where the user supplies their own X app's
// consumer key/secret + access token/secret instead of relying on seenpaid's
// own X OAuth app (which X's Pay-Per-Use console has been unreliable about).
// v2 POST /2/tweets and v1.1 media/upload both accept OAuth 1.0a user context.
//
// Getting the signature base string and percent-encoding exactly right is the
// entire game here — verified against X's published reference vector in the
// test.

// RFC 3986 percent-encoding: stricter than encodeURIComponent — also encodes
// ! * ' ( ) and leaves ~ unescaped.
export function percentEncode(str: string): string {
  return encodeURIComponent(str).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
}

// The signature base string: METHOD & percentEncode(url) & percentEncode(sorted params).
export function buildBaseString(method: string, url: string, params: Record<string, string>): string {
  const normalized = Object.keys(params)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(params[k]!)}`)
    .join('&')
  return [method.toUpperCase(), percentEncode(url), percentEncode(normalized)].join('&')
}

// HMAC-SHA1(base, consumerSecret&tokenSecret) → base64.
export function sign(baseString: string, consumerSecret: string, tokenSecret: string): string {
  const key = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`
  return createHmac('sha1', key).update(baseString).digest('base64')
}

export interface Oauth1Creds {
  consumerKey: string    // the X app's API key
  consumerSecret: string // the X app's API secret
  token: string          // the user's access token
  tokenSecret: string    // the user's access token secret
}

// Builds the OAuth 1.0a `Authorization` header for a request. `extraParams`
// are query/form params folded into the signature — X's /2/tweets sends a JSON
// body, which is NOT signed, so it's usually empty. nonce/timestamp are
// injectable so the signature is deterministic under test.
export function buildOAuth1Header(
  method: string,
  url: string,
  creds: Oauth1Creds,
  extraParams: Record<string, string> = {},
  fixed?: { nonce: string; timestamp: string },
): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: fixed?.nonce ?? randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: fixed?.timestamp ?? String(Math.floor(Date.now() / 1000)),
    oauth_token: creds.token,
    oauth_version: '1.0',
  }
  const base = buildBaseString(method, url, { ...oauth, ...extraParams })
  oauth.oauth_signature = sign(base, creds.consumerSecret, creds.tokenSecret)
  const header = Object.keys(oauth)
    .sort()
    .map((k) => `${percentEncode(k)}="${percentEncode(oauth[k]!)}"`)
    .join(', ')
  return `OAuth ${header}`
}
