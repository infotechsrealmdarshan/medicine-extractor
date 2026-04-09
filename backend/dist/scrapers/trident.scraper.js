"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.tridentScraper = exports.TridentScraper = void 0;
const playwright_1 = require("playwright");
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const logger_1 = __importDefault(require("../utils/logger"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const delay = (ms) => new Promise((res) => setTimeout(res, ms));
const DEFAULT_TRIDENT_URL = 'https://www.tridentonline.co.uk/trident/login';
const DEFAULT_ALL_PRODUCTS_URL = 'https://www.tridentonline.co.uk/trident/AllProducts';
class TridentScraper {
    constructor() {
        this.browser = null;
        this.storageStatePath = path_1.default.join(process.cwd(), '.trident_session', 'storage-state.json');
    }
    async launchBrowser() {
        this.browser = await playwright_1.chromium.launch({
            headless: true,
            args: ['--disable-blink-features=AutomationControlled'],
        });
    }
    async init() {
        if (!this.browser || !this.browser.isConnected()) {
            await this.launchBrowser();
        }
        fs_1.default.mkdirSync(path_1.default.dirname(this.storageStatePath), { recursive: true });
    }
    async newContext() {
        await this.init();
        try {
            return await this.browser.newContext({
                storageState: fs_1.default.existsSync(this.storageStatePath) ? this.storageStatePath : undefined,
                viewport: { width: 1440, height: 900 },
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
            });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.toLowerCase().includes('has been closed')) {
                logger_1.default.warn('Trident: Browser context creation failed due to closed browser. Relaunching...');
                await this.launchBrowser();
                return this.browser.newContext({
                    storageState: fs_1.default.existsSync(this.storageStatePath) ? this.storageStatePath : undefined,
                    viewport: { width: 1440, height: 900 },
                    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                });
            }
            throw error;
        }
    }
    async acceptCookies(page) {
        try {
            const oneTrustAccept = page.locator('#onetrust-accept-btn-handler').first();
            if (await oneTrustAccept.isVisible().catch(() => false)) {
                await oneTrustAccept.click({ timeout: 3000 }).catch(() => { });
                await delay(500);
                return;
            }
            const buttons = page.locator('button');
            const count = await buttons.count();
            for (let i = 0; i < count; i++) {
                const button = buttons.nth(i);
                const text = ((await button.textContent()) || '').toLowerCase();
                if (text.includes('accept all cookies') ||
                    text.includes('accept cookies') ||
                    text === 'accept') {
                    await button.click({ timeout: 3000 }).catch(() => { });
                    await delay(500);
                    return;
                }
            }
        }
        catch {
            logger_1.default.info('Trident: No cookie banner interaction required.');
        }
    }
    async clearCookieOverlay(page) {
        await this.acceptCookies(page);
        await page.evaluate(() => {
            const selectors = [
                '#onetrust-consent-sdk',
                '.onetrust-pc-dark-filter',
                '.onetrust-pc-light-filter',
                '.onetrust-pc-dark-filter.ot-fade-in',
                '.onetrust-pc-light-filter.ot-fade-in',
            ];
            selectors.forEach((selector) => {
                document.querySelectorAll(selector).forEach((el) => {
                    el.style.display = 'none';
                    el.setAttribute('aria-hidden', 'true');
                });
            });
            document.body.style.overflow = 'auto';
        }).catch(() => { });
    }
    async isLoginPage(page) {
        const loginIndicators = [
            page.locator('input[placeholder*="jane265"]'),
            page.locator('input[name="username"]'),
            page.locator('input[type="password"]'),
            page.getByRole('button', { name: /sign in/i }),
        ];
        for (const indicator of loginIndicators) {
            if (await indicator.count()) {
                return true;
            }
        }
        const text = (await page.textContent('body').catch(() => '')) || '';
        return text.includes("Enter your details below and we'll do the rest");
    }
    async login(page) {
        const username = (process.env.TRIDENT_USERNAME || '').trim();
        const password = (process.env.TRIDENT_PASSWORD || '').trim();
        if (!username || !password) {
            throw new Error('TRIDENT_USERNAME or TRIDENT_PASSWORD is missing');
        }
        logger_1.default.info('Trident: Logging in in background mode...');
        await this.clearCookieOverlay(page);
        await this.acceptCookies(page);
        await page.waitForLoadState('domcontentloaded');
        const usernameLocator = page.locator('input[placeholder*="jane265"], input[name="username"], input[type="text"]').first();
        if (!(await usernameLocator.isVisible().catch(() => false))) {
            // Some hub routes do not render the login form directly; force the explicit login page.
            await page.goto(DEFAULT_TRIDENT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await this.acceptCookies(page);
        }
        const usernameField = page.locator('input[placeholder*="jane265"], input[name="username"], input[type="text"]').first();
        const passwordField = page.locator('input[placeholder*="Spider26"], input[name="password"], input[type="password"]').first();
        await usernameField.waitFor({ state: 'visible', timeout: 20000 });
        await passwordField.waitFor({ state: 'visible', timeout: 20000 });
        await usernameField.click({ timeout: 5000 }).catch(() => { });
        await usernameField.fill('');
        await usernameField.type(username, { delay: 25 });
        await usernameField.press('Tab').catch(() => { });
        await passwordField.click({ timeout: 5000 }).catch(() => { });
        await passwordField.fill('');
        await passwordField.type(password, { delay: 25 });
        await passwordField.press('Tab').catch(() => { });
        const typedPasswordLength = (await passwordField.inputValue().catch(() => '')).length;
        if (typedPasswordLength !== password.length) {
            throw new Error(`Trident password entry mismatch (typed length ${typedPasswordLength}, expected ${password.length})`);
        }
        const signInButton = page.getByRole('button', { name: /sign in/i }).first();
        try {
            await this.clearCookieOverlay(page);
            await Promise.all([
                page.waitForLoadState('networkidle').catch(() => { }),
                signInButton.click({ timeout: 10000 }),
            ]);
        }
        catch (clickError) {
            const message = clickError instanceof Error ? clickError.message.toLowerCase() : String(clickError).toLowerCase();
            if (message.includes('intercepts pointer events') || message.includes('timeout')) {
                logger_1.default.warn('Trident: Sign-in click blocked, clearing cookie overlay and retrying...');
                await this.clearCookieOverlay(page);
                await Promise.all([
                    page.waitForLoadState('networkidle').catch(() => { }),
                    signInButton.click({ timeout: 10000, force: true }).catch(async () => {
                        await passwordField.press('Enter');
                    }),
                ]);
            }
            else {
                throw clickError;
            }
        }
        await delay(3000);
        const bodyText = ((await page.textContent('body').catch(() => '')) || '').toLowerCase();
        if (bodyText.includes("sorry we can't find your details") ||
            bodyText.includes('forgot password') && bodyText.includes("enter your details below")) {
            throw new Error(`Trident rejected the username/password from .env (typed password length: ${typedPasswordLength})`);
        }
        if (await this.isLoginPage(page)) {
            throw new Error('Login did not complete; Trident remained on the sign-in page');
        }
    }
    async ensureAuthenticated(page) {
        const loginUrl = process.env.TRIDENT_URL || DEFAULT_TRIDENT_URL;
        await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await this.acceptCookies(page);
        // If custom hub URL does not present login/authenticated state clearly, fall back to explicit Trident login page.
        if (!(await this.isLoginPage(page))) {
            const hasKnownAuthenticatedMarkers = (await page.locator('.cc_header_store_container, .branch-name, span.account-name').count().catch(() => 0)) > 0;
            if (!hasKnownAuthenticatedMarkers) {
                await page.goto(DEFAULT_TRIDENT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
                await this.acceptCookies(page);
            }
        }
        if (await this.isLoginPage(page)) {
            await this.login(page);
        }
    }
    getAllProductsUrl() {
        return (process.env.TRIDENT_PRODUCTS_URL || DEFAULT_ALL_PRODUCTS_URL).trim();
    }
    getEffectiveAccountFromProductsUrl(productsUrl) {
        try {
            const parsed = new URL(productsUrl);
            return parsed.searchParams.get('effectiveAccount');
        }
        catch {
            return null;
        }
    }
    async searchFromAllProducts(page, query) {
        const productsUrl = this.getAllProductsUrl();
        logger_1.default.info(`Trident: Navigating to AllProducts page: ${productsUrl}`);
        await page.goto(productsUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await this.acceptCookies(page);
        if (await this.isLoginPage(page)) {
            return false;
        }
        const searchInput = page
            .locator('input[name="searchText"], input[type="search"], .cc_quick_search input, .cc_search_input, input[placeholder*="Search"]')
            .first();
        if ((await searchInput.count()) === 0) {
            logger_1.default.warn('Trident: Search input not found on AllProducts page.');
            return false;
        }
        await searchInput.waitFor({ state: 'visible', timeout: 15000 });
        await searchInput.fill(query);
        await searchInput.press('Enter').catch(() => { });
        const searchButton = page
            .locator('button[type="submit"], .cc_quick_search button, [class*="search"] button')
            .first();
        if ((await searchButton.count()) > 0) {
            await searchButton.click({ timeout: 5000 }).catch(() => { });
        }
        await page.waitForLoadState('networkidle').catch(() => { });
        return true;
    }
    buildDirectSearchUrl(query) {
        const productsUrl = this.getAllProductsUrl();
        const effectiveAccount = this.getEffectiveAccountFromProductsUrl(productsUrl);
        const base = `https://www.tridentonline.co.uk/trident/searchresults?operation=quickSearch&searchText=${encodeURIComponent(query)}`;
        return effectiveAccount ? `${base}&effectiveAccount=${encodeURIComponent(effectiveAccount)}` : base;
    }
    async saveSession(context) {
        await context.storageState({ path: this.storageStatePath });
    }
    async selectConfiguredAccount(page) {
        const configuredAccount = (process.env.TRIDENT_ACCOUNT_NAME ||
            process.env.TRIDENT_BRANCH ||
            '').trim();
        if (!configuredAccount) {
            return;
        }
        logger_1.default.info(`Trident: Ensuring configured account "${configuredAccount}" is selected...`);
        const currentAccount = ((await page
            .locator('.cc_header_store_container, .branch-name, span.account-name')
            .first()
            .textContent()
            .catch(() => '')) || '').trim();
        if (currentAccount.toLowerCase().includes(configuredAccount.toLowerCase())) {
            return;
        }
        await page.goto('https://www.tridentonline.co.uk/trident/SelectAccount', {
            waitUntil: 'domcontentloaded',
            timeout: 60000,
        });
        await this.acceptCookies(page);
        await delay(1500);
        const accountLink = page.locator('a, button, span').filter({ hasText: configuredAccount }).first();
        if ((await accountLink.count()) === 0) {
            logger_1.default.warn(`Trident: Configured account "${configuredAccount}" was not found on SelectAccount page.`);
            return;
        }
        await Promise.all([
            page.waitForLoadState('networkidle').catch(() => { }),
            accountLink.click({ timeout: 10000 }).catch(async () => {
                await accountLink.evaluate((el) => el.click());
            }),
        ]);
        await delay(1500);
    }
    async waitForResults(page) {
        await page.waitForFunction(() => {
            const bodyText = document.body.innerText.toLowerCase();
            const items = document.querySelectorAll('.cc_product_item, .cc_row_item, .product-item').length > 0;
            const noResults = bodyText.includes('no results found') ||
                bodyText.includes('0 results') ||
                bodyText.includes('no matching products');
            const stillLogin = bodyText.includes("enter your details below and we'll do the rest");
            return items || noResults || stillLogin;
        }, { timeout: 30000 });
    }
    async extractProducts(page) {
        return page.evaluate(() => {
            const items = Array.from(document.querySelectorAll('.cc_product_item, .cc_row_item, .product-item'));
            const products = items
                .map((item) => {
                const titleEl = item.querySelector('.flexFontProductTitle, .cc_product_link, p.cc_product_link, [class*="productTitle"]');
                const priceEl = item.querySelector('.cc_price, .price, .plp-price-col, [class*="price"]');
                const title = titleEl?.innerText.trim() || '';
                const price = parseFloat(priceEl?.innerText.replace(/[^0-9.]/g, '') || '0') || 0;
                const text = (item.textContent || '').toLowerCase();
                const html = item.innerHTML.toLowerCase();
                const inStock = text.includes('in stock') ||
                    text.includes('available') ||
                    html.includes('green-check') ||
                    html.includes('checkmark');
                if (!title) {
                    return null;
                }
                return {
                    source: 'trident',
                    title,
                    price,
                    inStock,
                };
            })
                .filter((product) => Boolean(product));
            return products.filter((product, index, self) => index === self.findIndex((candidate) => candidate.title === product.title));
        });
    }
    async saveFailureScreenshot(page, query) {
        try {
            const screenshotPath = path_1.default.join(process.cwd(), 'screenshots', `trident-failure-${query}-${Date.now()}.png`);
            fs_1.default.mkdirSync(path_1.default.dirname(screenshotPath), { recursive: true });
            await page.screenshot({ path: screenshotPath, fullPage: true });
            logger_1.default.error(`Trident: Failure screenshot saved to ${screenshotPath}`);
        }
        catch (screenshotError) {
            logger_1.default.error(`Trident: Failed to capture screenshot: ${screenshotError}`);
        }
    }
    async scrape(query) {
        const context = await this.newContext();
        const page = await context.newPage();
        try {
            logger_1.default.info(`Trident: Starting headless scrape for query: ${query}`);
            await this.ensureAuthenticated(page);
            await this.selectConfiguredAccount(page);
            await this.saveSession(context);
            const allProductsSearchWorked = await this.searchFromAllProducts(page, query);
            if (!allProductsSearchWorked) {
                logger_1.default.warn('Trident: AllProducts search path failed, falling back to direct search URL.');
                const fallbackUrl = this.buildDirectSearchUrl(query);
                await page.goto(fallbackUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
                await this.acceptCookies(page);
            }
            await this.waitForResults(page).catch(() => { });
            if (await this.isLoginPage(page)) {
                logger_1.default.warn('Trident: Search redirected back to login, retrying authentication once...');
                await this.login(page);
                await this.saveSession(context);
                const retryUrl = this.buildDirectSearchUrl(query);
                await page.goto(retryUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
                await this.waitForResults(page).catch(() => { });
            }
            if (await this.isLoginPage(page)) {
                throw new Error('Search page remained unauthenticated after retry');
            }
            const products = await this.extractProducts(page);
            logger_1.default.info(`Trident: Headless scrape complete. Found ${products.length} products.`);
            return products;
        }
        catch (error) {
            logger_1.default.error(`Trident: Scrape failed: ${error}`);
            await this.saveFailureScreenshot(page, query);
            throw error;
        }
        finally {
            await context.close();
        }
    }
    async checkAuthentication() {
        const context = await this.newContext();
        const page = await context.newPage();
        try {
            await this.ensureAuthenticated(page);
            await this.selectConfiguredAccount(page);
            await this.saveSession(context);
            const productsUrl = this.getAllProductsUrl();
            await page.goto(productsUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await this.acceptCookies(page);
            if (await this.isLoginPage(page)) {
                throw new Error('Authenticated session could not be established for Trident AllProducts');
            }
            return { ok: true, message: 'Trident authentication succeeded' };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await this.saveFailureScreenshot(page, 'auth-check');
            return { ok: false, message };
        }
        finally {
            await context.close();
        }
    }
    async close() {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
        }
    }
}
exports.TridentScraper = TridentScraper;
exports.tridentScraper = new TridentScraper();
