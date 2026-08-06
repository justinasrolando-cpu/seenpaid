import { Router } from 'express'
import { requireApiKey } from '../../../auth/single-user.js'
import { PresignUploadSchema, RegisterMediaSchema, GenerateImageSchema } from '../../../domain/features/media/dto.js'
import { MediaService } from '../../../domain/features/media/media.service.js'

const router = Router()
const mediaService = new MediaService()

router.use(requireApiKey())

router.post('/presign', async (req, res, next) => {
  try {
    const dto = PresignUploadSchema.parse(req.body)
    const result = await mediaService.createUploadUrl(req.orgId!, dto)
    res.json({ success: true, data: result })
  } catch (err) { next(err) }
})

router.post('/', async (req, res, next) => {
  try {
    const dto = RegisterMediaSchema.parse(req.body)
    const media = await mediaService.register(req.orgId!, dto)
    res.status(201).json({ success: true, data: media })
  } catch (err) { next(err) }
})

// Generate an image from a prompt (free, keyless) and register it as media.
router.post('/generate', async (req, res, next) => {
  try {
    const dto = GenerateImageSchema.parse(req.body)
    const media = await mediaService.generateImage(req.orgId!, dto.prompt)
    res.status(201).json({ success: true, data: media })
  } catch (err) { next(err) }
})

export default router
