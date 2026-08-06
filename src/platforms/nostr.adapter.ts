// ─────────────────────────────────────────────────────────────────────────
// Nostr adapter — key-based, no OAuth.
//
// Nostr has no central server: a user is a keypair, and "posting" means signing
// a kind:1 note and broadcasting it to relays. The user connects by pasting
// their private key (nsec1… or 64-char hex). We derive their public key for
// display and store the private key as the account credential (encrypted at
// rest like every other token). There is no dev-app registration for anyone —
// this connects and publishes for real out of the box.
//
// Relays default to a well-known public set; override with NOSTR_RELAYS
// (comma-separated wss:// URLs).
// ─────────────────────────────────────────────────────────────────────────
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools'
import { Relay, useWebSocketImplementation } from 'nostr-tools/relay'
import WebSocket from 'ws'
import { ApiError } from '../errors/index.js'

// Relay connects over WebSocket — a global in the browser and in Node >=22, but
// NOT in the node:20 runtime this ships on (Dockerfile). So every Nostr publish
// threw "WebSocket is not defined" in prod while passing locally on Node 24.
// Inject the `ws` implementation. Relay AND useWebSocketImplementation must come
// from the SAME 'nostr-tools/relay' module: the main 'nostr-tools' bundle carries
// its own copy of the relay code, so injecting via the main entry wouldn't reach
// the Relay used here.
useWebSocketImplementation(WebSocket)
import type {
  AccountProfile, OAuthTokenSet, PlatformAdapter, PublishInput, PublishResult,
} from './types.js'

const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://relay.primal.net',
]

function relays(): string[] {
  const fromEnv = process.env.NOSTR_RELAYS?.split(',').map((r) => r.trim()).filter(Boolean)
  return fromEnv && fromEnv.length ? fromEnv : DEFAULT_RELAYS
}

// Accept either an nsec (bech32) or a raw 64-char hex private key and return
// the 32-byte secret key. Throws a clean 400 on anything malformed so the
// connect form can surface it.
function decodeSecretKey(input: string): Uint8Array {
  const trimmed = input.trim()
  if (trimmed.startsWith('nsec1')) {
    try {
      const { type, data } = nip19.decode(trimmed)
      if (type !== 'nsec') throw new Error('not an nsec')
      return data as Uint8Array
    } catch {
      throw new ApiError(400, 'Invalid Nostr private key (nsec could not be decoded)')
    }
  }
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Uint8Array.from(Buffer.from(trimmed, 'hex'))
  }
  throw new ApiError(400, 'Invalid Nostr private key — paste an nsec1… key or a 64-character hex key')
}

export class NostrAdapter implements PlatformAdapter {
  readonly id = 'nostr' as const

  getAuthorizeUrl(): string {
    throw new ApiError(400, 'Nostr does not use OAuth — connect with a private key instead')
  }

  async exchangeCodeForTokens(): Promise<OAuthTokenSet> {
    throw new ApiError(400, 'Nostr does not use OAuth — connect with a private key instead')
  }

  async refreshTokens(refreshToken: string): Promise<OAuthTokenSet> {
    // Keys don't expire; the refresh sweep is a no-op for Nostr.
    return { accessToken: refreshToken }
  }

  async fetchAccountProfile(): Promise<AccountProfile> {
    // Profile is derived at connect time from the key, never re-fetched.
    throw new ApiError(400, 'Nostr profile is set at connect time')
  }

  // Validate the pasted key and derive the public identity. The credential we
  // persist is the hex private key (accessToken); externalAccountId is the hex
  // pubkey so reconnecting with the same key upserts the same account.
  async connectKey(privateKey: string): Promise<{ tokens: OAuthTokenSet; profile: AccountProfile }> {
    const sk = decodeSecretKey(privateKey)
    const pubkey = getPublicKey(sk)
    const npub = nip19.npubEncode(pubkey)
    return {
      tokens: { accessToken: Buffer.from(sk).toString('hex') },
      profile: {
        externalAccountId: pubkey,
        displayName: `${npub.slice(0, 12)}…${npub.slice(-4)}`,
      },
    }
  }

  // Sign a kind:1 note and broadcast to the relay set. Nostr kind:1 has no
  // native media, so any image/video URLs are appended to the text (clients
  // render trailing image URLs inline). Succeeds if at least one relay accepts.
  async publish(input: PublishInput): Promise<PublishResult> {
    const sk = Uint8Array.from(Buffer.from(input.accessToken, 'hex'))
    const mediaUrls = input.media.map((m) => m.url)
    const content = [input.caption, ...mediaUrls].filter(Boolean).join('\n\n')

    const event = finalizeEvent({
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content,
    }, sk)

    const targets = relays()
    const results = await Promise.allSettled(
      targets.map(async (url) => {
        const relay = await Relay.connect(url)
        try {
          await relay.publish(event)
        } finally {
          relay.close()
        }
      }),
    )

    const accepted = results.filter((r) => r.status === 'fulfilled').length
    if (accepted === 0) {
      const firstErr = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined
      throw new ApiError(502, `Nostr publish failed on all ${targets.length} relays: ${firstErr?.reason ?? 'unknown error'}`)
    }

    // Nostr has no canonical post URL; njump.me resolves any note id to a
    // human-viewable page across clients.
    const nevent = nip19.neventEncode({ id: event.id })
    return { externalPostId: event.id, externalUrl: `https://njump.me/${nevent}` }
  }
}
