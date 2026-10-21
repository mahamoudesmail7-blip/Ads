// routes/researchReference.js — PUBLIC (no login) GET /api/research-ref/:token → the owner's reference photo, only while its 25-minute unguessable token lives.
// Exists so a reverse-image engine (Google Lens via SerpApi) can fetch the photo; nothing else is exposed here.
import { Router } from 'express';
import { getHostedImage } from '../services/researchReferenceHost.js';

const router = Router();
router.get('/:token', (req, res) => {
  const img = getHostedImage(req.params.token);
  if (!img) return res.status(404).end();
  res.set({ 'Content-Type': img.mediaType, 'Cache-Control': 'private, max-age=60', 'X-Robots-Tag': 'noindex', 'Content-Length': String(img.buffer.length) });
  res.send(img.buffer);
});
export default router;
