import { ApiError } from '../errors/index.js'

const GRAPH_VERSION = 'v22.0'
const GRAPH_URL = `https://graph.facebook.com/${GRAPH_VERSION}`

export interface MetaPage {
  id: string
  name: string
  access_token: string
  instagram_business_account?: { id: string }
}

// Meta doesn't always return expires_in (observed live: absent on some
// long-lived token exchange responses) — falling back to 60 days (the
// documented long-lived token lifetime) avoids `new Date(NaN)`, which
// crashes with "Invalid time value" when Postgres tries to serialize it.
const DEFAULT_LONG_LIVED_EXPIRES_IN = 60 * 24 * 60 * 60

export async function exchangeMetaCode(code: string, redirectUri: string): Promise<{ accessToken: string; expiresIn: number }> {
  const params = new URLSearchParams({
    client_id: process.env.META_APP_ID ?? '',
    client_secret: process.env.META_APP_SECRET ?? '',
    redirect_uri: redirectUri,
    code,
  })
  const res = await fetch(`${GRAPH_URL}/oauth/access_token?${params.toString()}`)
  if (!res.ok) throw new ApiError(502, `Meta token exchange failed: ${res.status} ${await res.text()}`)

  const data = await res.json() as { access_token: string; expires_in?: number }
  return { accessToken: data.access_token, expiresIn: data.expires_in || DEFAULT_LONG_LIVED_EXPIRES_IN }
}

// Short-lived user tokens (~1-2h) are exchanged for a long-lived one
// (~60 days) immediately after login — this is what we persist.
export async function getLongLivedUserToken(shortLivedToken: string): Promise<{ accessToken: string; expiresIn: number }> {
  const params = new URLSearchParams({
    grant_type: 'fb_exchange_token',
    client_id: process.env.META_APP_ID ?? '',
    client_secret: process.env.META_APP_SECRET ?? '',
    fb_exchange_token: shortLivedToken,
  })
  const res = await fetch(`${GRAPH_URL}/oauth/access_token?${params.toString()}`)
  if (!res.ok) throw new ApiError(502, `Meta long-lived token exchange failed: ${res.status} ${await res.text()}`)

  const data = await res.json() as { access_token: string; expires_in?: number }
  return { accessToken: data.access_token, expiresIn: data.expires_in || DEFAULT_LONG_LIVED_EXPIRES_IN }
}

// Page access tokens derived from a long-lived user token don't expire as
// long as the user token stays valid, which is why we store the *page*
// token as this account's accessToken rather than the user token.
export async function listManagedPages(userAccessToken: string): Promise<MetaPage[]> {
  const params = new URLSearchParams({
    access_token: userAccessToken,
    fields: 'id,name,access_token,instagram_business_account',
  })
  const res = await fetch(`${GRAPH_URL}/me/accounts?${params.toString()}`)
  if (!res.ok) throw new ApiError(502, `Meta pages list failed: ${res.status} ${await res.text()}`)

  const data = await res.json() as { data: MetaPage[] }
  return data.data
}

export { GRAPH_URL }
