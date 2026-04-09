import { myPinScraper } from '../scrapers/mypin.scraper';
import { tridentScraper } from '../scrapers/trident.scraper';
import { ProductData } from '../scrapers/mypin.scraper';
import logger from '../utils/logger';

export interface SearchResponse {
  products: ProductData[];
  failures: Partial<Record<'myp-i-n' | 'trident', string>>;
}

export class SearchService {
  async search(query: string): Promise<SearchResponse> {
    logger.info(`SearchService.search called with query: ${query}`);
    
    try {
      // Run both scrapers in parallel
      const results = await Promise.allSettled([
        myPinScraper.scrape(query),
        tridentScraper.scrape(query)
      ]);

      const flattenedResults: ProductData[] = [];
      const failures: SearchResponse['failures'] = {};
      
      results.forEach((result, index) => {
        const source = index === 0 ? 'myp-i-n' : 'trident';
        if (result.status === 'fulfilled') {
          flattenedResults.push(...result.value);
        } else {
          const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
          failures[source] = message;
          logger.error(`Error in ${source} scraper: ${message}`);
        }
      });

      return { products: flattenedResults, failures };
    } catch (error) {
      logger.error(`Error in SearchService: ${error}`);
      return { products: [], failures: { 'myp-i-n': 'Unexpected search service failure', trident: 'Unexpected search service failure' } };
    }
  }
}

export const searchService = new SearchService();
