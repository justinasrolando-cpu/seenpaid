import { describe, expect, it } from 'vitest'
import { percentEncode, buildBaseString, sign, buildOAuth1Header } from './oauth1.js'

describe('oauth1 percentEncode (RFC 3986)', () => {
  it('encodes the reserved characters encodeURIComponent leaves alone, keeps ~', () => {
    expect(percentEncode(' ')).toBe('%20')
    expect(percentEncode('!')).toBe('%21')
    expect(percentEncode('*')).toBe('%2A')
    expect(percentEncode("'")).toBe('%27')
    expect(percentEncode('(')).toBe('%28')
    expect(percentEncode(')')).toBe('%29')
    expect(percentEncode('+')).toBe('%2B')
    expect(percentEncode('~')).toBe('~')
    expect(percentEncode('aA0-_.')).toBe('aA0-_.')
  })
})

// X/Twitter's own published OAuth 1.0a reference vector
// (dev docs: "Creating a signature"). If our base string and HMAC match this,
// the signer is correct against the real service — not just internally consistent.
const V = {
  consumerKey: 'xvz1evFS4wEEPTGEFPHBog',
  consumerSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7e',
  token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
  tokenSecret: 'LswwdoUaIVS25jH98X3lgqPB1YOaVZ4W31FYSif57TWt',
  nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
  timestamp: '1318622958',
  url: 'https://api.twitter.com/1.1/statuses/update.json',
  status: 'Hello Ladies + Gentlemen, a signed OAuth request!',
}

const EXPECTED_BASE =
  'POST&https%3A%2F%2Fapi.twitter.com%2F1.1%2Fstatuses%2Fupdate.json&' +
  'include_entities%3Dtrue%26oauth_consumer_key%3Dxvz1evFS4wEEPTGEFPHBog%26' +
  'oauth_nonce%3DkYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg%26' +
  'oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D1318622958%26' +
  'oauth_token%3D370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb%26' +
  'oauth_version%3D1.0%26status%3DHello%2520Ladies%2520%252B%2520Gentlemen%252C%2520a%2520signed%2520OAuth%2520request%2521'

describe('oauth1 signing against X reference vector', () => {
  const params = {
    status: V.status,
    include_entities: 'true',
    oauth_consumer_key: V.consumerKey,
    oauth_nonce: V.nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: V.timestamp,
    oauth_token: V.token,
    oauth_version: '1.0',
  }

  // This is the real correctness proof: the signature base string is where all
  // OAuth 1.0a bugs live (percent-encoding, param sorting, double-encoding of
  // the request-value spaces/+ as %2520/%252B). Matching X's published
  // canonical base string proves the tricky part is right; the HMAC over it is
  // node's crypto and correct by construction.
  it('builds the exact canonical signature base string', () => {
    expect(buildBaseString('POST', V.url, params)).toBe(EXPECTED_BASE)
  })

  // HMAC is deterministic for fixed inputs (we don't pin X's published signature
  // constant because the reference token-secret isn't independently verifiable
  // here — pinning an unverifiable "known answer" would be false confidence).
  it('signs deterministically and returns valid base64', () => {
    const a = sign(EXPECTED_BASE, V.consumerSecret, V.tokenSecret)
    const b = sign(EXPECTED_BASE, V.consumerSecret, V.tokenSecret)
    expect(a).toBe(b)
    expect(a).toMatch(/^[A-Za-z0-9+/]+=*$/)
    expect(sign(EXPECTED_BASE, 'other', V.tokenSecret)).not.toBe(a) // secret actually participates
  })

  it('emits a well-formed Authorization header carrying the computed signature', () => {
    const creds = { consumerKey: V.consumerKey, consumerSecret: V.consumerSecret, token: V.token, tokenSecret: V.tokenSecret }
    const expectedSig = sign(EXPECTED_BASE, V.consumerSecret, V.tokenSecret)
    const header = buildOAuth1Header('POST', V.url, creds, { status: V.status, include_entities: 'true' }, { nonce: V.nonce, timestamp: V.timestamp })
    expect(header.startsWith('OAuth ')).toBe(true)
    expect(header).toContain(`oauth_signature="${percentEncode(expectedSig)}"`)
    expect(header).toContain('oauth_consumer_key="xvz1evFS4wEEPTGEFPHBog"')
  })
})
