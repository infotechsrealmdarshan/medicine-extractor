import { Router } from 'express';
import { searchController } from '../controllers/search.controller';

const router = Router();

router.post('/search', searchController.search);
router.get('/trident-auth-check', searchController.tridentAuthCheck);

export default router;
