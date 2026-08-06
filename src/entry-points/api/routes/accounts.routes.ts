import { Router } from 'express'
import { z } from 'zod'
import { requireApiKey } from '../../../auth/single-user.js'
import { AccountsService } from '../../../domain/features/accounts/accounts.service.js'
import { ConnectAccountCallbackSchema, ConnectBlueskySchema, ConnectDiscordSchema, ConnectTelegramSchema, ConnectNostrSchema, ConnectDevtoSchema, ConnectHashnodeSchema, ConnectMediumSchema, ConnectSlackSchema, ConnectWordpressSchema, ConnectGhostSchema, ConnectLemmySchema, ConnectWebhookSchema, ConnectMicroblogSchema, ConnectMatrixSchema, ConnectXByokSchema } from '../../../domain/features/accounts/dto.js'
import { PlatformIdSchema } from '../../../domain/features/posts/dto.js'
import { requireParam } from '../require-param.js'

const router = Router()
const accountsService = new AccountsService()

router.use(requireApiKey())

router.get('/', async (req, res, next) => {
  try {
    res.json({ success: true, data: await accountsService.list(req.orgId!) })
  } catch (err) { next(err) }
})

router.get('/:platform/authorize-url', async (req, res, next) => {
  try {
    const platform = PlatformIdSchema.parse(req.params.platform)
    const redirectUri = z.string().url().parse(req.query.redirectUri)
    const { url, state } = await accountsService.getAuthorizeUrl(req.orgId!, platform, redirectUri)
    res.json({ success: true, data: { url, state } })
  } catch (err) { next(err) }
})

router.post('/callback', async (req, res, next) => {
  try {
    const dto = ConnectAccountCallbackSchema.parse(req.body)
    const account = await accountsService.connect(req.orgId!, dto)
    res.status(201).json({ success: true, data: account })
  } catch (err) { next(err) }
})

// Bluesky has no OAuth redirect flow — connect directly with an app password.
router.post('/bluesky/connect', async (req, res, next) => {
  try {
    const dto = ConnectBlueskySchema.parse(req.body)
    const account = await accountsService.connectBluesky(req.orgId!, dto)
    res.status(201).json({ success: true, data: account })
  } catch (err) { next(err) }
})

// Discord connects with a channel webhook URL (no OAuth).
router.post('/discord/connect', async (req, res, next) => {
  try {
    const dto = ConnectDiscordSchema.parse(req.body)
    const account = await accountsService.connectDiscord(req.orgId!, dto)
    res.status(201).json({ success: true, data: account })
  } catch (err) { next(err) }
})

// Telegram connects with a bot token + target channel id (no OAuth).
router.post('/telegram/connect', async (req, res, next) => {
  try {
    const dto = ConnectTelegramSchema.parse(req.body)
    const account = await accountsService.connectTelegram(req.orgId!, dto)
    res.status(201).json({ success: true, data: account })
  } catch (err) { next(err) }
})

// X BYOK: paste your own X app's 4 OAuth 1.0a keys (no shared X app needed).
router.post('/x/byok', async (req, res, next) => {
  try {
    const dto = ConnectXByokSchema.parse(req.body)
    const account = await accountsService.connectXByok(req.orgId!, dto)
    res.status(201).json({ success: true, data: account })
  } catch (err) { next(err) }
})

// Nostr connects with a private key (nsec/hex, no OAuth).
router.post('/nostr/connect', async (req, res, next) => {
  try {
    const dto = ConnectNostrSchema.parse(req.body)
    const account = await accountsService.connectNostr(req.orgId!, dto)
    res.status(201).json({ success: true, data: account })
  } catch (err) { next(err) }
})

// Article platforms — key/token connect (no OAuth).
router.post('/devto/connect', async (req, res, next) => {
  try {
    const dto = ConnectDevtoSchema.parse(req.body)
    const account = await accountsService.connectDevto(req.orgId!, dto)
    res.status(201).json({ success: true, data: account })
  } catch (err) { next(err) }
})

router.post('/hashnode/connect', async (req, res, next) => {
  try {
    const dto = ConnectHashnodeSchema.parse(req.body)
    const account = await accountsService.connectHashnode(req.orgId!, dto)
    res.status(201).json({ success: true, data: account })
  } catch (err) { next(err) }
})

router.post('/medium/connect', async (req, res, next) => {
  try {
    const dto = ConnectMediumSchema.parse(req.body)
    const account = await accountsService.connectMedium(req.orgId!, dto)
    res.status(201).json({ success: true, data: account })
  } catch (err) { next(err) }
})

// Slack connects with an Incoming Webhook URL (no OAuth).
router.post('/slack/connect', async (req, res, next) => {
  try {
    const dto = ConnectSlackSchema.parse(req.body)
    const account = await accountsService.connectSlack(req.orgId!, dto)
    res.status(201).json({ success: true, data: account })
  } catch (err) { next(err) }
})

// WordPress connects with a site URL + Application Password (no OAuth).
router.post('/wordpress/connect', async (req, res, next) => {
  try {
    const dto = ConnectWordpressSchema.parse(req.body)
    const account = await accountsService.connectWordpress(req.orgId!, dto)
    res.status(201).json({ success: true, data: account })
  } catch (err) { next(err) }
})

// Ghost connects with an Admin API key (no OAuth).
router.post('/ghost/connect', async (req, res, next) => {
  try {
    const dto = ConnectGhostSchema.parse(req.body)
    const account = await accountsService.connectGhost(req.orgId!, dto)
    res.status(201).json({ success: true, data: account })
  } catch (err) { next(err) }
})

// Lemmy connects with instance credentials + community (no OAuth).
router.post('/lemmy/connect', async (req, res, next) => {
  try {
    const dto = ConnectLemmySchema.parse(req.body)
    const account = await accountsService.connectLemmy(req.orgId!, dto)
    res.status(201).json({ success: true, data: account })
  } catch (err) { next(err) }
})

// Webhook connects with any https URL (no OAuth).
router.post('/webhook/connect', async (req, res, next) => {
  try {
    const dto = ConnectWebhookSchema.parse(req.body)
    const account = await accountsService.connectWebhook(req.orgId!, dto)
    res.status(201).json({ success: true, data: account })
  } catch (err) { next(err) }
})

// Micro.blog connects with an app token (no OAuth).
router.post('/microblog/connect', async (req, res, next) => {
  try {
    const dto = ConnectMicroblogSchema.parse(req.body)
    const account = await accountsService.connectMicroblog(req.orgId!, dto)
    res.status(201).json({ success: true, data: account })
  } catch (err) { next(err) }
})

// Matrix connects with a homeserver + access token + room id (no OAuth).
router.post('/matrix/connect', async (req, res, next) => {
  try {
    const dto = ConnectMatrixSchema.parse(req.body)
    const account = await accountsService.connectMatrix(req.orgId!, dto)
    res.status(201).json({ success: true, data: account })
  } catch (err) { next(err) }
})

router.delete('/:id', async (req, res, next) => {
  try {
    const id = requireParam(req.params, 'id')
    await accountsService.disconnect(req.orgId!, id)
    res.status(204).send()
  } catch (err) { next(err) }
})

export default router
