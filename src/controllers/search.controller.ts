import { Request, Response } from 'express';
import { searchService } from '../services/search.service';
import { tridentScraper } from '../scrapers/trident.scraper';
import logger from '../utils/logger';

export class SearchController {
  async search(req: Request, res: Response) {
    const { query } = req.body;

    if (!query) {
      return res.status(400).json({ success: false, error: 'Query is required' });
    }

    try {
      logger.info(`Controller: Searching for ${query}`);
      const results = await searchService.search(query);
      return res.status(200).json({
        success: true,
        data: results.products,
        meta: {
          failures: results.failures,
        },
      });
    } catch (error) {
      logger.error(`Controller Error: ${error}`);
      return res.status(500).json({
        success: false,
        error: 'Internal server error during search',
      });
    }
  }

  async tridentAuthCheck(req: Request, res: Response) {
    try {
      logger.info('Controller: Running Trident auth check');
      const result = await tridentScraper.checkAuthentication();

      return res.status(result.ok ? 200 : 401).json({
        success: result.ok,
        message: result.message,
      });
    } catch (error) {
      logger.error(`Controller Error (tridentAuthCheck): ${error}`);
      return res.status(500).json({
        success: false,
        error: 'Internal server error during trident auth check',
      });
    }
  }
}

export const searchController = new SearchController();
