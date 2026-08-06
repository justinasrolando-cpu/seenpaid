import { Router } from 'express'
import { requireApiKey } from '../../../auth/single-user.js'
import { CreatePostSchema, UpdatePostSchema } from '../../../domain/features/posts/dto.js'
import { PostsService } from '../../../domain/features/posts/posts.service.js'
import { requireParam } from '../require-param.js'

const router = Router()
const postsService = new PostsService()

router.use(requireApiKey())

router.get('/', async (req, res, next) => {
  try {
    res.json({ success: true, data: await postsService.list(req.orgId!) })
  } catch (err) { next(err) }
})

router.get('/:id', async (req, res, next) => {
  try {
    const id = requireParam(req.params, 'id')
    res.json({ success: true, data: await postsService.get(req.orgId!, id) })
  } catch (err) { next(err) }
})

router.post('/', async (req, res, next) => {
  try {
    const dto = CreatePostSchema.parse(req.body)
    const post = await postsService.create(req.orgId!, 'api', dto)
    res.status(201).json({ success: true, data: post })
  } catch (err) { next(err) }
})

router.patch('/:id', async (req, res, next) => {
  try {
    const id = requireParam(req.params, 'id')
    const dto = UpdatePostSchema.parse(req.body)
    const post = await postsService.update(req.orgId!, id, dto)
    res.json({ success: true, data: post })
  } catch (err) { next(err) }
})

router.post('/:id/cancel', async (req, res, next) => {
  try {
    const id = requireParam(req.params, 'id')
    const post = await postsService.cancel(req.orgId!, id)
    res.json({ success: true, data: post })
  } catch (err) { next(err) }
})

router.delete('/:id', async (req, res, next) => {
  try {
    const id = requireParam(req.params, 'id')
    await postsService.delete(req.orgId!, id)
    res.status(204).send()
  } catch (err) { next(err) }
})

export default router
