import { chromium, Browser, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import logger from '../utils/logger';
import dotenv from 'dotenv';
import { ProductData } from './mypin.scraper';
import { blockDumbResources } from '../utils/playwright-utils';

dotenv.config();

const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));

const DEFAULT_AAH_LOGIN_URL = 'https://www.aah.co.uk/aahpoint/login';
const DEFAULT_AAH_PRODUCTS_URL = 'https://www.aah.co.uk/aahpoint/AllProducts';

export class AahScraper {
  private browser: Browser | null = null;
  private readonly storageStatePath = path.join(
    process.cwd(),
    '.aah_session',
    'storage-state.json',
  );

  // ─── Browser lifecycle ────────────────────────────────────────────────────

  private async launchBrowser() {
    logger.debug('AAH: Launching Playwright browser...');
    this.browser = await chromium.launch({
      headless: true,
      args: ['--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage', '--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
    });
    logger.debug('AAH: Browser launched.');
  }

  async init() {
    if (!this.browser || !this.browser.isConnected()) {
      await this.launchBrowser();
    }
    fs.mkdirSync(path.dirname(this.storageStatePath), { recursive: true });
  }

  private async newContext(): Promise<BrowserContext> {
    await this.init();
    try {
      return await this.browser!.newContext({
        storageState: fs.existsSync(this.storageStatePath)
          ? this.storageStatePath
          : undefined,
        viewport: { width: 1440, height: 900 },
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes('has been closed')) {
        logger.warn('AAH: Browser context creation failed (closed browser). Relaunching...');
        await this.launchBrowser();
        return this.browser!.newContext({
          storageState: fs.existsSync(this.storageStatePath)
            ? this.storageStatePath
            : undefined,
          viewport: { width: 1440, height: 900 },
          userAgent:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        });
      }
      throw error;
    }
  }

  private async saveSession(context: BrowserContext) {
    await context.storageState({ path: this.storageStatePath });
  }

  // ─── Cookie / overlay helpers ─────────────────────────────────────────────

  private async acceptCookies(page: Page) {
    try {
      // Wait up to 5 s for any cookie banner to appear before scanning
      await page
        .waitForSelector(
          '#onetrust-accept-btn-handler, button:has-text("Accept All Cookies"), button:has-text("Accept Cookies")',
          { state: 'visible', timeout: 5000 },
        )
        .catch(() => { }); // no banner is fine

      // OneTrust-specific button
      const oneTrustAccept = page.locator('#onetrust-accept-btn-handler').first();
      if (await oneTrustAccept.isVisible().catch(() => false)) {
        await oneTrustAccept.click({ timeout: 3000 }).catch(() => { });
        await delay(500);
        return;
      }

      // Generic text match (handles custom cookie modals like AAH's)
      const buttons = page.locator('button');
      const count = await buttons.count();
      for (let i = 0; i < count; i++) {
        const button = buttons.nth(i);
        const text = ((await button.textContent()) || '').toLowerCase().trim();
        if (
          text.includes('accept all cookies') ||
          text.includes('accept cookies') ||
          text === 'accept'
        ) {
          await button.click({ timeout: 3000 }).catch(() => { });
          await delay(500);
          return;
        }
      }
    } catch {
      logger.info('AAH: No cookie banner interaction required.');
    }
  }

  private async clearCookieOverlay(page: Page) {
    await this.acceptCookies(page);
    await page.evaluate(() => {
      const selectors = [
        '#onetrust-consent-sdk',
        '.onetrust-pc-dark-filter',
        '.onetrust-pc-light-filter',
      ];
      selectors.forEach((selector) => {
        document.querySelectorAll(selector).forEach((el) => {
          (el as HTMLElement).style.display = 'none';
          (el as HTMLElement).setAttribute('aria-hidden', 'true');
        });
      });
      document.body.style.overflow = 'auto';
    }).catch(() => { });
  }

  // ─── Auth helpers ─────────────────────────────────────────────────────────

  private async isLoginPage(page: Page): Promise<boolean> {
    const url = page.url();

    // Only trust explicit login/signin URL patterns
    if (url.includes('/login') || url.includes('/signin')) return true;

    // Presence of a password input means we're on a login form
    if ((await page.locator('input[type="password"]').count().catch(() => 0)) > 0) return true;

    // Salesforce LWC login page body text
    const text = (await page.textContent('body').catch(() => '')) || '';
    if (text.includes("Enter your details below and we'll do the rest")) return true;

    return false;
  }

  private async login(page: Page) {
    const username = (process.env.AAH_USERNAME || '').trim();
    const password = (process.env.AAH_PASSWORD || '').trim();

    if (!username || !password) {
      throw new Error('AAH_USERNAME or AAH_PASSWORD is missing from .env');
    }

    logger.info('AAH: Logging in...');

    await this.clearCookieOverlay(page);
    await this.acceptCookies(page);
    await page.waitForLoadState('domcontentloaded');

    // Accept the cookie modal BEFORE interacting with the login form
    await this.acceptCookies(page);

    // Wait explicitly for the password field – it only appears after the cookie
    // modal is gone and the login form has fully rendered.
    await page
      .waitForSelector('input[type="password"]', { state: 'visible', timeout: 20000 })
      .catch(() => {
        logger.warn('AAH: Password field did not appear within 20 s after cookie dismiss.');
      });

    // AAH login uses Salesforce LWC – the form fields have no name/autocomplete
    // attributes; they are identified only by their placeholder text.
    // Use pressSequentially() (real keystrokes) so LWC input events fire and
    // the "Sign in" button transitions from disabled to enabled.
    const usernameField = page
      .locator('input[placeholder*="jane265"], input[placeholder*="username" i], input[name="username"]')
      .first();
    const passwordField = page
      .locator('input[type="password"]')
      .first();

    await usernameField.waitFor({ state: 'visible', timeout: 20000 });
    await passwordField.waitFor({ state: 'visible', timeout: 20000 });

    await usernameField.click({ timeout: 5000 }).catch(() => { });
    await usernameField.pressSequentially(username, { delay: 50 });
    await usernameField.press('Tab').catch(() => { });

    await passwordField.click({ timeout: 5000 }).catch(() => { });
    await passwordField.pressSequentially(password, { delay: 50 });
    await delay(500); // let LWC validate and enable the Sign In button

    const signInButton = page.getByRole('button', { name: /sign in/i }).first();
    try {
      await this.clearCookieOverlay(page);
      await Promise.all([
        page
          .waitForURL(
            // Wait until we leave any login/signin URL
            (url) =>
              !url.href.includes('/login') &&
              !url.href.includes('/signin') &&
              !url.href.includes('SelectAccount'),
            { timeout: 20000 },
          )
          .catch(() => { }),
        signInButton.click({ timeout: 10000 }),
      ]);
    } catch (clickError) {
      const msg =
        clickError instanceof Error
          ? clickError.message.toLowerCase()
          : String(clickError).toLowerCase();
      if (msg.includes('intercepts pointer events') || msg.includes('timeout')) {
        logger.warn('AAH: Sign-in click blocked, clearing overlay and retrying...');
        await this.clearCookieOverlay(page);
        await Promise.all([
          page
            .waitForURL(
              (url) => !url.href.includes('login') && !url.href.includes('SelectAccount'),
              { timeout: 15000 },
            )
            .catch(() => { }),
          signInButton.click({ timeout: 10000, force: true }).catch(async () => {
            await passwordField.press('Enter');
          }),
        ]);
      } else {
        throw clickError;
      }
    }

    await delay(3000);

    const bodyText = ((await page.textContent('body').catch(() => '')) || '').toLowerCase();

    if (bodyText.includes('temporarily locked') || bodyText.includes('too many failed attempts')) {
      throw new Error('AAH account is temporarily locked. Please wait 15 minutes before retrying.');
    }

    if (
      bodyText.includes("sorry we can't find your details") ||
      (bodyText.includes('forgot password') && bodyText.includes('enter your details below'))
    ) {
      throw new Error('AAH rejected the username/password – please check AAH_USERNAME / AAH_PASSWORD in .env');
    }

    if (await this.isLoginPage(page)) {
      throw new Error('AAH: Login did not complete; still on sign-in page');
    }

    logger.info('AAH: Login successful');
  }

  private async ensureAuthenticated(page: Page, targetUrl?: string) {
    // Optimistic approach: try the target URL directly first.
    // If no targetUrl is provided, default to AllProducts.
    const urlToCheck = targetUrl || this.getAllProductsUrl();

    logger.info(`AAH: Checking authentication by navigating to: ${urlToCheck}`);
    const response = await page.goto(urlToCheck, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await this.acceptCookies(page);

    if (!(await this.isLoginPage(page))) {
      logger.info(`AAH: Session is valid.`);
      return;
    }

    logger.info('AAH: Session expired or not found – authenticating...');
    const loginUrl = process.env.AAH_URL || DEFAULT_AAH_LOGIN_URL;
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await this.login(page);

    // After login, if we weren't already at our target, go there.
    if (page.url() !== urlToCheck) {
      await page.goto(urlToCheck, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await this.acceptCookies(page);
    }
  }

  // ─── URL helpers ──────────────────────────────────────────────────────────

  private getAllProductsUrl(): string {
    return (process.env.AAH_PRODUCTS_URL || DEFAULT_AAH_PRODUCTS_URL).trim();
  }

  private buildDirectSearchUrl(query: string): string {
    return `https://www.aah.co.uk/aahpoint/searchresults?operation=quickSearch&searchText=${encodeURIComponent(query)}`;
  }

  // ─── Search via AllProducts search bar ───────────────────────────────────

  private async searchFromAllProducts(page: Page, query: string): Promise<boolean> {
    const productsUrl = this.getAllProductsUrl();
    logger.info(`AAH: Navigating to AllProducts page: ${productsUrl}`);
    // Use domcontentloaded – the AAH portal has persistent background XHR that
    // prevents networkidle from ever settling within 60 s.
    try {
      await page.goto(productsUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch (e) {
      logger.warn(`AAH: Navigation to AllProducts timed out or failed: ${e}`);
    }
    await delay(3000);
    await this.acceptCookies(page);

    if (await this.isLoginPage(page)) {
      return false;
    }

    const SEARCH_SELECTOR =
      'input[name="searchText"], input#searchCode, input[type="search"], ' +
      '.cc_quick_search input, .cc_search_input, ' +
      'input[placeholder*="search" i], input[placeholder*="product code" i]';

    // Wait up to 15 s for the input to appear
    await page
      .waitForSelector(SEARCH_SELECTOR, { state: 'visible', timeout: 15000 })
      .catch(() => { });

    const searchInput = page.locator(SEARCH_SELECTOR).first();

    if ((await searchInput.count()) === 0) {
      logger.warn('AAH: Search input not found on AllProducts page.');
      return false;
    }

    await searchInput.waitFor({ state: 'visible', timeout: 10000 });
    await searchInput.click().catch(() => { });
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

  // ─── Result waiting & extraction ──────────────────────────────────────────

  private async waitForResults(page: Page) {
    logger.debug('AAH: waitForResults starting...');
    const waitStart = Date.now();
    await page
      .waitForFunction(
        () => {
          // Clear any cookie overlay that blocks the DOM
          const cookieButton = document.querySelector(
            '#onetrust-accept-btn-handler',
          ) as HTMLElement;
          if (cookieButton && cookieButton.offsetParent !== null) {
            cookieButton.click();
          }

          const bodyText = document.body.innerText.toLowerCase();

          const items =
            Array.from(document.querySelectorAll(
              '.cc_product_item, .cc_row_item, .product-item, ' +
              'table.searchresults tbody tr, .search-results-table tbody tr, ' +
              'tbody tr.productRow, tbody tr[class*="product"], ' +
              '.cc_product_listing tbody tr',
            )).some((el: any) => (el.innerText || '').trim().length > 10);

          const noResults =
            bodyText.includes('no results found') ||
            bodyText.includes('did not return any results') ||
            /\b0 results\b/.test(bodyText) ||
            bodyText.includes('no matching products') ||
            /showing\s+1\s*-\s*0\s+of\s+0/.test(bodyText);

          const hasResultCount = /showing\s+\d+\s*-\s*\d+\s+of\s+\d+/i.test(bodyText);

          const stillLogin = bodyText.includes(
            "enter your details below and we'll do the rest",
          );

          // Additional check: wait for prices to appear if items are found
          const hasPrice = (document.querySelector('.cc_price, .price, .plp-price-col, [class*="price"]') as HTMLElement)?.innerText?.trim().length > 0;

          return (items && hasPrice) || noResults || hasResultCount || stillLogin;
        },
        undefined,
        { timeout: 20000 },
      )
      .catch((err) => {
        logger.warn(`AAH: waitForResults timed out or failed: ${err.message}. Proceeding with extraction.`);
      });

    // Also wait for the spinner to disappear if present
    await page.waitForSelector('.slds-spinner_container', { state: 'hidden', timeout: 10000 }).catch(() => { });

    logger.debug(`AAH: waitForResults done in ${Date.now() - waitStart}ms. Current URL: ${page.url()}`);
    await this.clearCookieOverlay(page).catch(() => { });
  }

  private async extractProducts(page: Page): Promise<ProductData[]> {
    logger.debug(`AAH: extractProducts called. URL: ${page.url()}`);
    const results = await page.evaluate(() => {
      // Helper to pierce Shadow DOM during extraction
      function findInShadow(root: Document | HTMLElement | ShadowRoot, selector: string): HTMLElement | null {
        const el = root.querySelector(selector) as HTMLElement | null;
        if (el) return el;
        const children = Array.from(root.children);
        for (const child of children) {
          if (child.shadowRoot) {
            const found = findInShadow(child.shadowRoot, selector);
            if (found) return found;
          }
          const found = findInShadow(child as HTMLElement, selector);
          if (found) return found;
        }
        return null;
      }

      function findAllInShadow(root: Document | HTMLElement | ShadowRoot, selector: string, results: Element[] = []) {
        root.querySelectorAll(selector).forEach(el => results.push(el));
        const children = Array.from(root.children);
        for (const child of children) {
          if (child.shadowRoot) findAllInShadow(child.shadowRoot, selector, results);
          findAllInShadow(child as HTMLElement, selector, results);
        }
        return results;
      }

      // 1. Try to find a list/table of results
      const LIST_SELECTORS = [
        'tbody tr.productRow',
        'tbody tr[class*="product"]',
        '.cc_product_item',
        '.cc_row_item',
        '.product-item',
        'table.searchresults tbody tr',
        '.search-results-table tbody tr',
        '.cc_product_listing tbody tr',
        'tbody tr:has(td a)',
      ];

      let items: Element[] = [];
      for (const sel of LIST_SELECTORS) {
        try {
          const found = Array.from(document.querySelectorAll(sel));
          if (found.length > 0) {
            items = found;
            break;
          }
        } catch { }
      }

      // Fallback: search in shadow DOM
      if (items.length === 0) {
        items = findAllInShadow(document, '.cc_product_item, .cc_row_item, [class*="product-row"]');
      }

      if (items.length > 0) {
        const products = items
          .map((item) => {
            const titleEl = (item.querySelector(
              '.flexFontProductTitle, .cc_product_link, p.cc_product_link, ' +
              '.product-link, [class*="productTitle"], td a, td:first-child, .cc_product_name'
            ) || findInShadow(item as HTMLElement, '.cc_product_name, .product-title')) as HTMLElement | null;

            const priceEl = (item.querySelector(
              '.cc_price, .price, .plp-price-col, [class*="price"], ' +
              'td[class*="price"], td:nth-child(3), .net-price, .your-price'
            ) || findInShadow(item as HTMLElement, '.price, .cc_price, [class*="price"]')) as HTMLElement | null;

            const title = titleEl?.innerText.trim() || '';
            const priceText = priceEl?.innerText || '';
            let price = parseFloat(priceText.replace(/[^0-9.]/g, '') || '0') || 0;

            const text = ((item as HTMLElement).innerText || item.textContent || '').toLowerCase();
            const html = item.innerHTML.toLowerCase();

            // Regex fallback for price if class selectors miss it
            if (price === 0) {
              // Try to find a pattern like £12.34 or simply 12.34 in a likely cell
              const priceMatch = text.match(/£\s*([\d,]+\.\d{2})/) || text.match(/contract\s*price\s*[:\s]*£?\s*([\d,]+\.\d{2})/i) || text.match(/your\s*price\s*[:\s]*£?\s*([\d,]+\.\d{2})/i);
              if (priceMatch) {
                price = parseFloat((priceMatch[1] || priceMatch[2]).replace(/,/g, ''));
              }
            }

            const inStock =
              text.includes('in stock') ||
              text.includes('available') ||
              html.includes('green-check') ||
              html.includes('checkmark') ||
              html.includes('check_circle') ||
              html.includes('success') ||
              text.includes('add to basket');

            const urlEl = titleEl as HTMLAnchorElement | null;
            const url = urlEl?.href || window.location.href;
            const pipMatch = item.textContent?.match(/\b(\d{7,8})\b/);
            const pip = pipMatch ? pipMatch[1] : '';

            if (!title || title.toLowerCase() === 'product title') return null;
            return { source: 'aah', title, price, inStock, url, pip } as ProductData;
          })
          .filter((p): p is ProductData => Boolean(p));

        if (products.length > 0) return products;
      }

      // 2. If no list items, check if we're on a Product Detail Page (PDP)
      const pdpTitleEl = (document.querySelector(
        'h1, .cc_product_title, .product-details h1, .product-details h2, .product-name'
      ) || findInShadow(document, 'h1, .product-name')) as HTMLElement | null;

        const pdpPriceEl = (document.querySelector(
          '.cc_price, .product-details .price, .price, span[id*="price"], .pdp-price, .contract-price, .net-price'
        ) || findInShadow(document, '.price, .cc_price, [class*="price"], .contract-price')) as HTMLElement | null;
  
        if (pdpTitleEl && pdpTitleEl.innerText.trim().length > 3) {
          const title = pdpTitleEl.innerText.trim();
          const priceText = pdpPriceEl?.innerText || '0';
          let price = parseFloat(priceText.replace(/[^0-9.]/g, '') || '0') || 0;
  
          const bodyText = document.body.innerText.toLowerCase();
          const bodyHtml = document.body.innerHTML.toLowerCase();
  
          // Fallback PDP price from body text
          if (price === 0) {
            const priceMatch = bodyText.match(/£\s*([\d,]+\.\d{2})/) || bodyText.match(/contract\s*price\s*[:\s]*£?\s*([\d,]+\.\d{2})/i) || bodyText.match(/your\s*price\s*[:\s]*£?\s*([\d,]+\.\d{2})/i);
            if (priceMatch) {
              price = parseFloat((priceMatch[1] || priceMatch[2]).replace(/,/g, ''));
            }
          }

        const inStock =
          bodyText.includes('in stock') ||
          bodyText.includes('item available') ||
          bodyText.includes('add to basket') ||
          bodyHtml.includes('green-check') ||
          bodyHtml.includes('checkmark') ||
          bodyHtml.includes('check_circle') ||
          bodyHtml.includes('success') ||
          document.body.querySelector('.cc_stock_status, .inventory_status, .slds-badge_success') !== null ||
          findInShadow(document, '.inventory-status, .cc_stock_status') !== null;

        if (price > 0 || inStock) {
          const url = window.location.href;
          const pipMatch = document.body.innerText.match(/\b(\d{7,8})\b/);
          const pip = pipMatch ? pipMatch[1] : '';
          return [{ source: 'aah', title, price, inStock, url, pip }];
        }
      }

      return [];
    });
    logger.debug(`AAH: extractProducts returned ${results.length} items.`);
    return results;
  }

  // ─── Screenshot helper ────────────────────────────────────────────────────

  private async saveFailureScreenshot(page: Page, label: string) {
    try {
      const screenshotPath = path.join(
        process.cwd(),
        'screenshots',
        `aah-failure-${label}-${Date.now()}.png`,
      );
      fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
      await page.screenshot({ path: screenshotPath, fullPage: true });
      logger.error(`AAH: Failure screenshot saved to ${screenshotPath}`);
    } catch (e) {
      logger.error(`AAH: Could not capture screenshot: ${e}`);
    }
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  async scrape(query: string): Promise<ProductData[]> {
    const scrapeStart = Date.now();
    const context = await this.newContext();
    const page = await context.newPage();
    await blockDumbResources(page);

    // Log page crashes to help diagnose "Target crashed" errors
    page.on('crash', () => {
      logger.error(`AAH: Page CRASHED for query "${query}". Will attempt browser reset.`);
    });

    try {
      logger.info(`AAH: Starting scrape for query: ${query}`);

      const directUrl = this.buildDirectSearchUrl(query);
      logger.debug(`AAH: Direct search URL: ${directUrl}`);
      await this.ensureAuthenticated(page, directUrl);
      await this.saveSession(context);

      // We are now either already at directUrl or have logged in and navigated there.
      await this.waitForResults(page);

      // Re-check session after navigation
      if (await this.isLoginPage(page)) {
        logger.warn('AAH: Redirected back to login after search – re-authenticating...');
        await this.login(page);
        await this.saveSession(context);
        const retryUrl = this.buildDirectSearchUrl(query);
        await page.goto(retryUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await this.waitForResults(page);
      }

      if (await this.isLoginPage(page)) {
        throw new Error('AAH: Search page remained unauthenticated after retry');
      }

      const products = await this.extractProducts(page);
      const elapsed = Date.now() - scrapeStart;
      logger.info(`AAH: Scrape complete in ${elapsed}ms. Found ${products.length} products.`);

      if (products.length === 0) {
        logger.warn(`AAH: No products found for "${query}". Saving diagnostic screenshot.`);
        await this.saveFailureScreenshot(page, `${query}-zero-results`);
      } else if (products.some(p => p.price === 0)) {
        logger.warn(`AAH: Some products have 0 price for "${query}". Saving diagnostic screenshot.`);
        await this.saveFailureScreenshot(page, `${query}-zero-price`);
      }

      return products;
    } catch (error) {
      const elapsed = Date.now() - scrapeStart;
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error(`AAH: Scrape failed after ${elapsed}ms: ${errMsg}`);

      // If the page crashed, reset the browser so next request starts fresh
      if (errMsg.includes('Target crashed') || errMsg.includes('Session closed') || errMsg.includes('Connection closed')) {
        logger.warn('AAH: Detected browser crash – resetting browser instance.');
        if (this.browser) {
          try { await this.browser.close(); } catch (_) { }
          this.browser = null;
        }
      }

      try { await this.saveFailureScreenshot(page, String(query)); } catch (_) { }
      throw error;
    } finally {
      try { await context.close(); } catch (_) { }
    }
  }

  async checkAuthentication(): Promise<{ ok: boolean; message: string }> {
    const context = await this.newContext();
    const page = await context.newPage();
    try {
      await this.ensureAuthenticated(page);
      await this.saveSession(context);
      return { ok: true, message: 'AAH authentication succeeded' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.saveFailureScreenshot(page, 'auth-check');
      return { ok: false, message };
    } finally {
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

export const aahScraper = new AahScraper();
