"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.searchController = exports.SearchController = void 0;
const search_service_1 = require("../services/search.service");
const trident_scraper_1 = require("../scrapers/trident.scraper");
const logger_1 = __importDefault(require("../utils/logger"));
class SearchController {
    async search(req, res) {
        const { query } = req.body;
        if (!query) {
            return res.status(400).json({ success: false, error: 'Query is required' });
        }
        try {
            logger_1.default.info(`Controller: Searching for ${query}`);
            const results = await search_service_1.searchService.search(query);
            return res.status(200).json({
                success: true,
                data: results.products,
                meta: {
                    failures: results.failures,
                },
            });
        }
        catch (error) {
            logger_1.default.error(`Controller Error: ${error}`);
            return res.status(500).json({
                success: false,
                error: 'Internal server error during search',
            });
        }
    }
    async tridentAuthCheck(req, res) {
        try {
            logger_1.default.info('Controller: Running Trident auth check');
            const result = await trident_scraper_1.tridentScraper.checkAuthentication();
            return res.status(result.ok ? 200 : 401).json({
                success: result.ok,
                message: result.message,
            });
        }
        catch (error) {
            logger_1.default.error(`Controller Error (tridentAuthCheck): ${error}`);
            return res.status(500).json({
                success: false,
                error: 'Internal server error during trident auth check',
            });
        }
    }
}
exports.SearchController = SearchController;
exports.searchController = new SearchController();
