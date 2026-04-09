"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.searchService = exports.SearchService = void 0;
const mypin_scraper_1 = require("../scrapers/mypin.scraper");
const trident_scraper_1 = require("../scrapers/trident.scraper");
const logger_1 = __importDefault(require("../utils/logger"));
class SearchService {
    async search(query) {
        logger_1.default.info(`SearchService.search called with query: ${query}`);
        try {
            // Run both scrapers in parallel
            const results = await Promise.allSettled([
                mypin_scraper_1.myPinScraper.scrape(query),
                trident_scraper_1.tridentScraper.scrape(query)
            ]);
            const flattenedResults = [];
            const failures = {};
            results.forEach((result, index) => {
                const source = index === 0 ? 'myp-i-n' : 'trident';
                if (result.status === 'fulfilled') {
                    flattenedResults.push(...result.value);
                }
                else {
                    const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
                    failures[source] = message;
                    logger_1.default.error(`Error in ${source} scraper: ${message}`);
                }
            });
            return { products: flattenedResults, failures };
        }
        catch (error) {
            logger_1.default.error(`Error in SearchService: ${error}`);
            return { products: [], failures: { 'myp-i-n': 'Unexpected search service failure', trident: 'Unexpected search service failure' } };
        }
    }
}
exports.SearchService = SearchService;
exports.searchService = new SearchService();
