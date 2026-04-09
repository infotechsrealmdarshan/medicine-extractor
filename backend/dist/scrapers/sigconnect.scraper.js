"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sigConnectScraper = exports.SigConnectScraper = void 0;
const playwright_extra_1 = require("playwright-extra");
const puppeteer_extra_plugin_stealth_1 = __importDefault(require("puppeteer-extra-plugin-stealth"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const logger_1 = __importDefault(require("../utils/logger"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
// Register the stealth plugin to clear security checks
playwright_extra_1.chromium.use((0, puppeteer_extra_plugin_stealth_1.default)());
const delay = (ms) => new Promise(res => setTimeout(res, ms));
class SigConnectScraper {
    constructor() {
        this.browser = null;
    }
    async init() {
        this.browser = await playwright_extra_1.chromium.launch({
            headless: true,
        });
    }
    async scrape(query) {
        if (!this.browser)
            await this.init();
        const context = await this.browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        });
        // 🍪 1. Inject Cookies if available
        const cookiePath = path_1.default.join(process.cwd(), 'sig_cookies.json');
        let cookiesInjected = false;
        if (fs_1.default.existsSync(cookiePath)) {
            try {
                const cookies = JSON.parse(fs_1.default.readFileSync(cookiePath, 'utf8'));
                await context.addCookies(cookies);
                logger_1.default.info('SigConnect: Session cookies injected from sig_cookies.json');
                cookiesInjected = true;
            }
            catch (err) {
                logger_1.default.error(`SigConnect: Failed to inject cookies: ${err}`);
            }
        }
        const page = await context.newPage();
        try {
            logger_1.default.info(`SigConnect: Starting scrape for query: ${query}`);
            // 2. Navigation & Login Skip
            const loginUrl = process.env.SIG_URL || 'https://www.sigconnect.co.uk/login';
            const dashboardUrl = 'https://www.sigconnect.co.uk/'; // Standard dashboard URL
            if (cookiesInjected) {
                logger_1.default.info('SigConnect: Attempting to skip login via injected session...');
                await page.goto(dashboardUrl, { waitUntil: 'networkidle', timeout: 60000 });
                await delay(2000);
                // Check if we are still on login page (cookies expired or invalid)
                const isStillLoginPage = await page.$('input[name="email"], input[type="email"]');
                if (!isStillLoginPage) {
                    logger_1.default.info('SigConnect: Session injection successful, login skipped.');
                }
                else {
                    logger_1.default.warn('SigConnect: Session injection failed (expired cookies), falling back to login...');
                    await this.performManualLogin(page, loginUrl);
                }
            }
            else {
                await this.performManualLogin(page, loginUrl);
            }
            // 2. Search
            const searchBoxSelector = 'input[placeholder*="Search"], input[name="search"], .search-input';
            await page.waitForSelector(searchBoxSelector, { timeout: 15000 });
            await delay(500);
            await page.type(searchBoxSelector, query, { delay: 120 });
            await delay(300);
            await page.keyboard.press('Enter');
            // 3. Wait for Results
            try {
                await Promise.race([
                    page.waitForSelector('table, .product-list, .results', { timeout: 20000 }),
                    page.waitForSelector('text=No products found, text=No matching', { timeout: 20000 }),
                ]);
            }
            catch (e) {
                logger_1.default.info(`SigConnect: No results found or timeout for ${query}`);
                return [];
            }
            // 4. Extraction Logic (Refined for Master-Detail Grid)
            const products = await page.evaluate(() => {
                const results = [];
                // Find all rows in the Sigma Catalogue
                const allRows = Array.from(document.querySelectorAll('table tr, .product-item, .product-row, [role="row"]'));
                let lastTitle = '';
                let lastInStock = false;
                allRows.forEach(row => {
                    const text = (row.textContent || '').trim();
                    const lowerText = text.toLowerCase();
                    // 🟢 Check if this is a Title Row (usually has a green dot or distinct title class)
                    // Based on the image, the title row has a status icon and then the name
                    const statusIcon = row.querySelector('.status-icon, [class*="status"], [style*="color: rgb(0, 128, 0)"]');
                    const titleElement = row.querySelector('h3, .product-name, [class*="title"], strong');
                    if (titleElement || (text.length > 5 && !text.includes('£') && !text.includes('%'))) {
                        lastTitle = titleElement?.textContent?.trim() || text.split('\n')[0].trim();
                        // Check for green dot (in-stock indicator)
                        const greenDot = row.innerHTML.includes('rgb(144, 238, 144)') || row.innerHTML.includes('green') || row.querySelector('.green-dot, .in-stock');
                        lastInStock = !!greenDot || lowerText.includes('in stock') || lowerText.includes('available');
                        return; // Move to next row to find price
                    }
                    // 💰 Check if this is a Detail Row (contains price/discount)
                    if (lowerText.includes('£') || /\d+\.\d{2}/.test(lowerText)) {
                        let price = 0;
                        const priceMatch = lowerText.match(/£\s?(\d+\.\d{2})/);
                        if (priceMatch)
                            price = parseFloat(priceMatch[1]);
                        // If we have a price but no title from this row, use the lastTitle
                        if (price > 0 && lastTitle) {
                            results.push({
                                source: 'sigconnect',
                                title: lastTitle,
                                price: price,
                                inStock: lastInStock || lowerText.includes('in stock')
                            });
                        }
                    }
                });
                // Fallback: If results are empty, try a more aggressive selector-based extraction
                if (results.length === 0) {
                    const blocks = document.querySelectorAll('.product-block, .product-item');
                    blocks.forEach(block => {
                        const title = block.querySelector('.title, .name')?.textContent?.trim() || 'Unknown';
                        const priceText = block.querySelector('.price, .inv, .invoice')?.textContent || '';
                        const priceMatch = priceText.match(/(\d+\.\d{2})/);
                        if (priceMatch) {
                            results.push({
                                source: 'sigconnect',
                                title,
                                price: parseFloat(priceMatch[1]),
                                inStock: block.textContent?.toLowerCase().includes('in stock') || false
                            });
                        }
                    });
                }
                return results;
            });
            logger_1.default.info(`SigConnect: Extracted ${products.length} products`);
            return products;
        }
        catch (error) {
            const timestamp = new Date().getTime();
            const screenshotPath = path_1.default.join(process.cwd(), 'screenshots', `sig-failure-${timestamp}.png`);
            await page.screenshot({ path: screenshotPath });
            logger_1.default.error(`SigConnect: Scraping failed: ${error}. Screenshot saved to ${screenshotPath}`);
            return [];
        }
        finally {
            await context.close();
        }
    }
    async performManualLogin(page, loginUrl) {
        logger_1.default.info('SigConnect: Navigating to login page...');
        await page.goto(loginUrl, { waitUntil: 'networkidle', timeout: 60000 });
        await delay(1000 + Math.random() * 2000);
        const isLoginPage = await page.$('input[name="email"], input[type="email"]');
        if (isLoginPage) {
            logger_1.default.info('SigConnect: Performing manual login...');
            await page.type('input[name="email"], input[type="email"]', process.env.SIG_USERNAME || '', { delay: 100 });
            await delay(500 + Math.random() * 1000);
            await page.type('input[name="password"], input[type="password"]', process.env.SIG_PASSWORD || '', { delay: 150 });
            await delay(800 + Math.random() * 1200);
            await page.click('button[type="submit"], #kt_sign_in_submit');
            await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => logger_1.default.warn('SigConnect: Login navigation timeout, proceeding...'));
            await delay(2000);
        }
    }
    async close() {
        if (this.browser) {
            await this.browser.close();
        }
    }
}
exports.SigConnectScraper = SigConnectScraper;
exports.sigConnectScraper = new SigConnectScraper();
