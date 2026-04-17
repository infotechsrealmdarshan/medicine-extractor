import { Request, Response } from 'express';
import { searchService } from '../services/search.service';
import { tridentScraper } from '../scrapers/trident.scraper';
import logger from '../utils/logger';

function normalizeQueries(body: Record<string, unknown>): string[] | null {
  const { query, queries } = body;

  if (Array.isArray(queries)) {
    const list = queries.map((q) => String(q).trim()).filter(Boolean);
    return list.length ? list : null;
  }

  if (typeof query === 'string' && query.trim()) {
    return [query.trim()];
  }

  return null;
}

export class SearchController {
  async search(req: Request, res: Response) {
    const normalized = normalizeQueries(req.body as Record<string, unknown>);

    if (!normalized) {
      return res.status(400).json({ success: false, error: 'Query or queries is required' });
    }

    // Capture the type of request: streaming or standard
    const isStream = req.query.stream === 'true' || req.headers.accept === 'text/event-stream';

    if (isStream) {
      // Set up SSE
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      const sendEvent = (data: any) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      try {
        logger.info(`Controller: Starting streaming search for ${normalized.length} terms`);
        const results = await searchService.searchMultiple(normalized, (progress: any) => {
          sendEvent({ type: 'progress', ...progress });
        });

        sendEvent({ type: 'done', data: results.products, meta: { queries: normalized, failuresByQuery: results.failuresByQuery } });
        res.end();
        return;
      } catch (error) {
        logger.error(`Stream error: ${error}`);
        sendEvent({ type: 'error', message: String(error) });
        res.end();
        return;
      }
    }

    try {
      if (normalized.length === 1) {
        const query = normalized[0];
        logger.info(`Controller: Searching for ${query}`);
        const results = await searchService.search(query);
        return res.status(200).json({
          success: true,
          data: results.products,
          meta: {
            failures: results.failures,
            queries: [query],
          },
        });
      }

      logger.info(`Controller: Multi-search for ${normalized.length} terms: ${normalized.join(' | ')}`);
      const results = await searchService.searchMultiple(normalized);
      return res.status(200).json({
        success: true,
        data: results.products,
        meta: {
          queries: normalized,
          failuresByQuery: results.failuresByQuery,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('At most') && message.includes('search terms')) {
        return res.status(400).json({ success: false, error: message });
      }
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
