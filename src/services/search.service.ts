import { myPinScraper } from '../scrapers/mypin.scraper';
import { tridentScraper } from '../scrapers/trident.scraper';
import { aahScraper } from '../scrapers/aah.scraper';
import { allianceScraper } from '../scrapers/alliance.scraper';
import { sigConnectScraper } from '../scrapers/sigconnect.scraper';
import { ProductData } from '../scrapers/mypin.scraper';
import logger from '../utils/logger';

export interface SearchResponse {
  products: ProductData[];
  failures: Partial<Record<'myp-i-n' | 'trident' | 'aah' | 'alliance' | 'sigconnect', string>>;
}

const MAX_MULTI_QUERIES = 25;

export interface MultiSearchResponse {
  products: ProductData[];
  failuresByQuery: Record<string, SearchResponse['failures']>;
}

export class SearchService {
  async search(query: string): Promise<SearchResponse> {
    logger.info(`SearchService.search called with query: ${query}`);

    try {
      const scraperNames: Array<'myp-i-n' | 'trident' | 'aah' | 'alliance' | 'sigconnect'> =
        ['myp-i-n', 'trident', 'aah', 'alliance', 'sigconnect'];

      const searchStart = Date.now();

      // Wrap each scraper with timing + per-scraper debug logging
      const SCRAPER_TIMEOUT = 60000; // 60 seconds

      const timedScrapers = [
        myPinScraper.scrape(query),
        tridentScraper.scrape(query),
        aahScraper.scrape(query),
        allianceScraper.scrape(query),
        sigConnectScraper.scrape(query),
      ].map((promise, i) => {
        const t0 = Date.now();
        // Race the scraper promise against a timeout promise
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Timeout: ${scraperNames[i]} scraper took more than ${SCRAPER_TIMEOUT / 1000}s`)), SCRAPER_TIMEOUT)
        );

        return Promise.race([promise, timeoutPromise])
          .then((products: ProductData[]) => {
            logger.info(`[${scraperNames[i]}] ✅ Done in ${Date.now() - t0}ms – ${products.length} product(s) found.`);
            return products;
          })
          .catch((err) => {
            logger.error(`[${scraperNames[i]}] ❌ Failed after ${Date.now() - t0}ms: ${err instanceof Error ? err.message : err}`);
            throw err;
          });
      });

      // Run all scrapers in parallel
      const results = await Promise.allSettled(timedScrapers);

      const totalElapsed = Date.now() - searchStart;
      logger.info(`SearchService: All scrapers settled in ${totalElapsed}ms.`);

      const flattenedResults: ProductData[] = [];
      const failures: SearchResponse['failures'] = {};

      results.forEach((result, index) => {
        const source = scraperNames[index];
        if (result.status === 'fulfilled') {
          flattenedResults.push(...result.value);
        } else {
          const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
          failures[source] = message;
          logger.error(`[${source}] Final error recorded: ${message}`);
        }
      });

      logger.info(`SearchService: Returning ${flattenedResults.length} total products. Failures: [${Object.keys(failures).join(', ') || 'none'}]`);
      return { products: flattenedResults, failures };
    } catch (error) {
      logger.error(`Error in SearchService: ${error}`);
      return { products: [], failures: { 'myp-i-n': 'Unexpected search service failure', trident: 'Unexpected search service failure', aah: 'Unexpected search service failure', alliance: 'Unexpected search service failure', sigconnect: 'Unexpected search service failure' } };
    }
  }

  /**
   * Runs one full supplier scan per query, in sequence (avoids concurrent Puppeteer use issues).
   */
  async searchMultiple(queries: string[], onProgress?: (p: { query: string; index: number; total: number; resultsFound: number }) => void): Promise<MultiSearchResponse> {
    const unique = [...new Set(queries.map((q) => q.trim()).filter(Boolean))];
    if (unique.length === 0) {
      return { products: [], failuresByQuery: {} };
    }
    if (unique.length > MAX_MULTI_QUERIES) {
      throw new Error(`At most ${MAX_MULTI_QUERIES} search terms allowed per request`);
    }

    const failuresByQuery: Record<string, SearchResponse['failures']> = {};
    const products: ProductData[] = [];

    let count = 0;
    for (const q of unique) {
      const r = await this.search(q);
      failuresByQuery[q] = r.failures;
      for (const p of r.products) {
        products.push({ ...p, matchedQuery: q });
      }
      count++;
      if (onProgress) {
        onProgress({ query: q, index: count, total: unique.length, resultsFound: r.products.length });
      }
    }

    return { products, failuresByQuery };
  }
}

export const searchService = new SearchService();

