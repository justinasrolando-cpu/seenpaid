// ─────────────────────────────────────────────────────────────────────────
// Hashnode adapter — Personal Access Token based, no OAuth. Self-serve: the
// user pastes a PAT (hashnode.com → Settings → Developer → Personal Access
// Tokens) plus the target publication id, and can publish immediately.
//
// Hashnode is a dev-blog platform (GraphQL API). Like Dev.to, it publishes
// ARTICLES, so we split the caption into title (first line) + markdown body.
// ─────────────────────────────────────────────────────────────────────────
import { ApiError } from '../errors/index.js'
import { splitTitleBody } from './devto.adapter.js'
import type {
  AccountProfile, OAuthTokenSet, PlatformAdapter, PublishInput, PublishResult,
} from './types.js'

const GQL = 'https://gql.hashnode.com'

async function hashnodeGql<T>(pat: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(GQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: pat },
    body: JSON.stringify({ query, variables }),
  })
  const json = await res.json() as { data?: T; errors?: { message: string }[] }
  if (!res.ok || json.errors?.length) {
    throw new ApiError(502, `Hashnode API error: ${json.errors?.map((e) => e.message).join('; ') ?? res.status}`)
  }
  return json.data as T
}

export class HashnodeAdapter implements PlatformAdapter {
  readonly id = 'hashnode' as const

  getAuthorizeUrl(): string {
    throw new ApiError(400, 'Hashnode does not use OAuth — connect with a Personal Access Token instead')
  }

  async exchangeCodeForTokens(): Promise<OAuthTokenSet> {
    throw new ApiError(400, 'Hashnode does not use OAuth — connect with a Personal Access Token instead')
  }

  async refreshTokens(refreshToken: string): Promise<OAuthTokenSet> {
    return { accessToken: refreshToken } // PATs don't auto-expire
  }

  async fetchAccountProfile(): Promise<AccountProfile> {
    throw new ApiError(400, 'Hashnode profile is set at connect time')
  }

  // Validate the PAT (via me{}) and confirm the publication is reachable. The
  // credential is the PAT; the account is keyed by the publication id so a post
  // always targets the right blog.
  async connectPat(pat: string, publicationId: string): Promise<{ tokens: OAuthTokenSet; profile: AccountProfile }> {
    const me = await hashnodeGql<{ me: { username: string; name?: string; profilePicture?: string } }>(
      pat, 'query { me { username name profilePicture } }', {},
    )
    const pub = await hashnodeGql<{ publication: { title: string } | null }>(
      pat, 'query ($id: ObjectId!) { publication(id: $id) { title } }', { id: publicationId },
    )
    if (!pub.publication) throw new ApiError(400, 'Hashnode publication not found for that id')
    return {
      tokens: { accessToken: pat },
      profile: {
        externalAccountId: publicationId,
        displayName: `${pub.publication.title} (@${me.me.username})`,
        avatarUrl: me.me.profilePicture,
      },
    }
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const { title, body } = splitTitleBody(input.caption)
    const image = input.media.find((m) => m.type === 'image')
    const contentMarkdown = image ? `![](${image.url})\n\n${body}` : body

    const data = await hashnodeGql<{ publishPost: { post: { id: string; url: string } } }>(
      input.accessToken,
      `mutation ($input: PublishPostInput!) {
        publishPost(input: $input) { post { id url } }
      }`,
      // Hashnode types PublishPostInput.tags as a non-null list, so the mutation
      // fails validation when it's omitted — send an empty array.
      { input: { title, contentMarkdown, publicationId: input.externalAccountId, tags: [] } },
    )
    const post = data.publishPost.post
    return { externalPostId: post.id, externalUrl: post.url }
  }
}
