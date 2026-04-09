"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.myPinScraper = exports.MyPinScraper = void 0;
const playwright_1 = require("playwright");
const path_1 = __importDefault(require("path"));
const logger_1 = __importDefault(require("../utils/logger"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const delay = (ms) => new Promise(res => setTimeout(res, ms));
class MyPinScraper {
    constructor() {
        this.browser = null;
    }
    async init() {
        if (!this.browser || !this.browser.isConnected()) {
            this.browser = await playwright_1.firefox.launch({
                headless: true,
            });
        }
    }
    async newContextWithRetry() {
        await this.init();
        try {
            return await this.browser.newContext({
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
            });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.toLowerCase().includes('has been closed')) {
                logger_1.default.warn('MyPin: Browser context was closed. Relaunching browser...');
                this.browser = null;
                await this.init();
                return this.browser.newContext({
                    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                });
            }
            throw error;
        }
    }
    async scrape(query) {
        const context = await this.newContextWithRetry();
        const page = await context.newPage();
        try {
            logger_1.default.info(`Starting scrape for query: ${query}`);
            // 1. Login with retry
            const loginUrl = 'https://www.myp-i-n.co.uk/pms/servlet/twaaserver?svcname=pmsacu&usrurl=../design&usrfunc=LO';
            let loginSuccess = false;
            for (let i = 0; i < 2; i++) {
                try {
                    logger_1.default.info(`Navigation attempt ${i + 1} to ${loginUrl}`);
                    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
                    loginSuccess = true;
                    break;
                }
                catch (e) {
                    logger_1.default.warn(`Navigation attempt ${i + 1} failed: ${e}`);
                    if (i === 1)
                        throw e;
                }
            }
            await page.waitForSelector('input[name="cuf_id"]', { timeout: 20000 });
            await page.fill('input[name="cuf_id"]', process.env.SUPPLIER_USERNAME || '');
            await page.fill('input[name="cuf_passwd"]', process.env.SUPPLIER_PASSWORD || '');
            await page.click('input[type="image"]'); // Confirm button image
            logger_1.default.info('Login submitted');
            // 2. Handle "Continue" or redirect
            try {
                await page.waitForSelector('input[value="Continue"]', { timeout: 5000 });
                await page.click('input[value="Continue"]');
                logger_1.default.info('Clicked Continue button');
            }
            catch (e) {
                logger_1.default.info('Continue button not found or already redirected');
            }
            // 3. Search with retry
            const searchUrl = 'https://www.myp-i-n.co.uk/pms/servlet/eboserver?svcname=e10h009&usrurl=../design';
            for (let i = 0; i < 2; i++) {
                try {
                    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
                    break;
                }
                catch (e) {
                    logger_1.default.warn(`Search page navigation attempt ${i + 1} failed: ${e}`);
                    if (i === 1)
                        throw e;
                }
            }
            // Detect if PIP code (7 digits)
            const isPipCode = /^\d{7}$/.test(query);
            if (isPipCode) {
                logger_1.default.info(`Detected PIP code: ${query}`);
                await page.waitForSelector('input[name="art_search"]', { timeout: 10000 });
                await page.fill('input[name="art_search"]', query);
                await page.keyboard.press('Enter');
            }
            else {
                logger_1.default.info(`Detected keyword search: ${query}`);
                await page.waitForSelector('input[name="search_words"]', { timeout: 10000 });
                await page.fill('input[name="search_words"]', query);
                await page.keyboard.press('Enter');
            }
            logger_1.default.info(`Search for ${query} submitted`);
            // 4. Extract
            try {
                // Wait for either the results table or an error message
                await Promise.race([
                    page.waitForSelector('table', { timeout: 15000 }),
                    page.waitForSelector('text=Not Known', { timeout: 15000 }),
                    page.waitForSelector('text=No matching products', { timeout: 15000 }),
                ]);
            }
            catch (e) {
                logger_1.default.info(`No results found or timeout for ${query}`);
                return [];
            }
            // Check for error text
            const isNotFound = await page.evaluate(() => {
                return document.body.innerText.includes('Is Not Known') ||
                    document.body.innerText.includes('No matching products found');
            });
            if (isNotFound) {
                logger_1.default.info(`Product not found for query: ${query}`);
                return [];
            }
            const products = await page.evaluate(() => {
                const rows = Array.from(document.querySelectorAll('table tr'));
                if (rows.length === 0)
                    return [];
                // 1. Detect if this is a "Detail View" (vertical table)
                // Detail views usually have "Description" or "PIP Code" in the first column of one of the first few rows
                const isDetailView = rows.some(row => {
                    const firstCellText = row.querySelector('td')?.innerText.trim() || '';
                    return firstCellText === 'PIP Code' || firstCellText === 'Description';
                });
                if (isDetailView) {
                    const data = {};
                    rows.forEach(row => {
                        const cells = row.querySelectorAll('td');
                        if (cells.length >= 2) {
                            const label = cells[0].innerText.trim();
                            const value = cells[1].innerText.trim();
                            data[label] = value;
                        }
                    });
                    if (data['Description'] || data['PIP Code']) {
                        const title = data['Description'] || 'Unknown Product';
                        const priceStr = data['Numark Price'] || data['Standard Sell Price'] || '0.00';
                        const price = parseFloat(priceStr.replace(/[^0-9.]/g, '')) || 0;
                        const stockStr = data['Availability'] || '';
                        const inStock = stockStr.toLowerCase().includes('in stock') ||
                            (stockStr.toLowerCase().includes('available') && !stockStr.toLowerCase().includes('not available'));
                        return [{
                                source: 'myp-i-n',
                                title,
                                price,
                                inStock,
                            }];
                    }
                }
                // 2. Fallback to "List View" (horizontal table)
                return rows.slice(1).map((row) => {
                    const cells = row.querySelectorAll('td');
                    if (cells.length < 8)
                        return null; // Need at least index 7 for Availability
                    const title = cells[1]?.innerText.trim() || 'Unknown';
                    // Price Strategy (Verified Indices):
                    // Index 4: Numark Price (Primary)
                    // Index 3: Standard Sell Price (Fallback)
                    // Index 2: Trade (Second Fallback)
                    const priceStr = cells[4]?.innerText.trim() || cells[3]?.innerText.trim() || cells[2]?.innerText.trim() || '0.00';
                    const price = parseFloat(priceStr.replace(/[^0-9.]/g, '')) || 0;
                    // Stock Strategy (Verified Index):
                    // Index 7: Availability column
                    const stockStr = cells[7]?.innerText.trim() || '';
                    const inStock = stockStr.toLowerCase().includes('in stock') ||
                        (stockStr.toLowerCase().includes('available') && !stockStr.toLowerCase().includes('not available'));
                    return {
                        source: 'myp-i-n',
                        title,
                        price,
                        inStock,
                    };
                }).filter(p => p !== null);
            });
            logger_1.default.info(`Extracted ${products.length} products`);
            return products;
        }
        catch (error) {
            const timestamp = new Date().getTime();
            const screenshotPath = path_1.default.join(process.cwd(), 'screenshots', `failure-${timestamp}.png`);
            await page.screenshot({ path: screenshotPath });
            logger_1.default.error(`Scraping failed: ${error}. Screenshot saved to ${screenshotPath}`);
            return [];
        }
        finally {
            await context.close();
        }
    }
    async close() {
        if (this.browser) {
            await this.browser.close();
        }
    }
}
exports.MyPinScraper = MyPinScraper;
exports.myPinScraper = new MyPinScraper();
