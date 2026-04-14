import { chromium, Browser, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import logger from '../utils/logger';
import dotenv from 'dotenv';
import { blockDumbResources } from '../utils/playwright-utils';

dotenv.config();

export interface ProductData {
  source: string;
  title: string;
  price: number;
  inStock: boolean;
  url?: string;
  pip?: string;
}

const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));
const DEFAULT_TRIDENT_URL = 'https://www.tridentonline.co.uk/trident/login';
const DEFAULT_ALL_PRODUCTS_URL = 'https://www.tridentonline.co.uk/trident/AllProducts';

export class TridentScraper {
  private browser: Browser | null = null;
  private readonly storageStatePath = path.join(process.cwd(), '.trident_session', 'storage-state.json');

  private async launchBrowser() {
    this.browser = await chromium.launch({
      headless: true,
      args: ['--disable-blink-features=AutomationControlled'],
    });
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
        storageState: fs.existsSync(this.storageStatePath) ? this.storageStatePath : undefined,
        viewport: { width: 1440, height: 900 },
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes('has been closed')) {
        logger.warn('Trident: Browser context creation failed due to closed browser. Relaunching...');
        await this.launchBrowser();
        return this.browser!.newContext({
          storageState: fs.existsSync(this.storageStatePath) ? this.storageStatePath : undefined,
          viewport: { width: 1440, height: 900 },
          userAgent:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        });
      }
      throw error;
    }
  }

  private async acceptCookies(page: Page) {
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
      logger.info('Trident: No cookie banner interaction required.');
    }
  }

  private async clearCookieOverlay(page: Page) {
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
          (el as HTMLElement).style.display = 'none';
          (el as HTMLElement).setAttribute('aria-hidden', 'true');
        });
      });

      document.body.style.overflow = 'auto';
    }).catch(() => { });
  }

  private async isLoginPage(page: Page): Promise<boolean> {
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

  private async login(page: Page) {
    const username = (process.env.TRIDENT_USERNAME || '').trim();
    const password = (process.env.TRIDENT_PASSWORD || '').trim();

    if (!username || !password) {
      throw new Error('TRIDENT_USERNAME or TRIDENT_PASSWORD is missing');
    }

    logger.info('Trident: Logging in in background mode...');

    await this.clearCookieOverlay(page);
    await this.acceptCookies(page);
    await page.waitForLoadState('domcontentloaded');

    const usernameLocator = page.locator(
      'input[placeholder*="jane265" i], input[name="username"], input[autocomplete="username"]',
    ).first();
    if (!(await usernameLocator.isVisible().catch(() => false))) {
      // Some hub routes do not render the login form directly; force the explicit login page.
      await page.goto(DEFAULT_TRIDENT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await this.acceptCookies(page);
    }

    const usernameField = page.locator(
      'input[placeholder*="jane265" i], input[name="username"], input[autocomplete="username"]',
    ).first();
    const passwordField = page.locator(
      'input[placeholder*="Spider26" i], input[name="password"], input[type="password"]',
    ).first();

    await usernameField.waitFor({ state: 'visible', timeout: 20000 });
    await passwordField.waitFor({ state: 'visible', timeout: 20000 });

    await usernameField.click({ timeout: 5000 }).catch(() => { });
    await usernameField.fill(username);
    await usernameField.press('Tab').catch(() => { });

    await passwordField.click({ timeout: 5000 }).catch(() => { });
    await passwordField.fill(password);
    await passwordField.press('Tab').catch(() => { });

    const typedPasswordLength = (await passwordField.inputValue().catch(() => '')).length;

    if (typedPasswordLength !== password.length) {
      throw new Error(
        `Trident password entry mismatch (typed length ${typedPasswordLength}, expected ${password.length})`,
      );
    }

    const signInButton = page.getByRole('button', { name: /sign in/i }).first();
    try {
      await this.clearCookieOverlay(page);
      await Promise.all([
        page.waitForURL((url) => !url.href.includes('login') && !url.href.includes('SelectAccount'), { timeout: 15000 }).catch(() => { }),
        signInButton.click({ timeout: 10000 }),
      ]);
    } catch (clickError) {
      const message = clickError instanceof Error ? clickError.message.toLowerCase() : String(clickError).toLowerCase();
      if (message.includes('intercepts pointer events') || message.includes('timeout')) {
        logger.warn('Trident: Sign-in click blocked, clearing cookie overlay and retrying...');
        await this.clearCookieOverlay(page);

        await Promise.all([
          page.waitForURL((url) => !url.href.includes('login') && !url.href.includes('SelectAccount'), { timeout: 15000 }).catch(() => { }),
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
      throw new Error('Trident account is temporarily locked. Please wait 15 minutes before retrying.');
    }

    if (
      bodyText.includes("sorry we can't find your details") ||
      (bodyText.includes('forgot password') && bodyText.includes("enter your details below"))
    ) {
      throw new Error(
        `Trident rejected the username/password from .env. Please check your credentials in the .env file.`,
      );
    }

    if (await this.isLoginPage(page)) {
      throw new Error('Login did not complete; Trident remained on the sign-in page');
    }
  }

  private async ensureAuthenticated(page: Page, targetUrl?: string) {
    const urlToCheck = targetUrl || this.getAllProductsUrl();
    logger.info(`Trident: Checking authentication via navigation to: ${urlToCheck}`);

    const response = await page.goto(urlToCheck, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await this.acceptCookies(page);

    if (!(await this.isLoginPage(page))) {
      logger.info(`Trident: Session is valid.`);
      return;
    }

    logger.info('Trident: Session expired or not found – authenticating...');
    await page.goto(DEFAULT_TRIDENT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await this.acceptCookies(page);
    await this.login(page);

    if (page.url() !== urlToCheck) {
      await page.goto(urlToCheck, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await this.acceptCookies(page);
    }
  }

  private getAllProductsUrl(): string {
    return (process.env.TRIDENT_PRODUCTS_URL || DEFAULT_ALL_PRODUCTS_URL).trim();
  }

  private getEffectiveAccountFromProductsUrl(productsUrl: string): string | null {
    try {
      const parsed = new URL(productsUrl);
      return parsed.searchParams.get('effectiveAccount');
    } catch {
      return null;
    }
  }

  private async searchFromAllProducts(page: Page, query: string): Promise<boolean> {
    const productsUrl = this.getAllProductsUrl();
    logger.info(`Trident: Navigating to AllProducts page: ${productsUrl}`);
    // domcontentloaded + delay avoids networkidle timeout from persistent background XHR
    await page.goto(productsUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await delay(2000);
    await this.acceptCookies(page);

    if (await this.isLoginPage(page)) {
      return false;
    }

    const SEARCH_SELECTOR =
      'input[name="searchText"], input#searchCode, input[type="search"], ' +
      '.cc_quick_search input, .cc_search_input, ' +
      'input[placeholder*="search" i], input[placeholder*="product code" i]';

    // waitForSelector FIRST so JS-rendered input has time to appear (up to 15 s)
    // before we check count – the old code checked count immediately and always got 0.
    await page
      .waitForSelector(SEARCH_SELECTOR, { state: 'visible', timeout: 15000 })
      .catch(() => { });

    const searchInput = page.locator(SEARCH_SELECTOR).first();

    if ((await searchInput.count()) === 0) {
      logger.warn('Trident: Search input not found on AllProducts page.');
      return false;
    }

    await searchInput.waitFor({ state: 'visible', timeout: 5000 });
    await searchInput.click().catch(() => { });
    await searchInput.pressSequentially(query, { delay: 30 });
    await searchInput.press('Enter').catch(() => { });

    const searchButton = page
      .locator('button[type="submit"], .cc_quick_search button, [class*="search"] button')
      .first();
    if ((await searchButton.count()) > 0) {
      await searchButton.click({ timeout: 5000 }).catch(() => { });
    }

    await page.waitForLoadState('domcontentloaded').catch(() => { });
    return true;
  }

  private buildDirectSearchUrl(query: string): string {
    const productsUrl = this.getAllProductsUrl();
    const effectiveAccount = this.getEffectiveAccountFromProductsUrl(productsUrl);
    const base = `https://www.tridentonline.co.uk/trident/searchresults?operation=quickSearch&searchText=${encodeURIComponent(query)}`;
    return effectiveAccount ? `${base}&effectiveAccount=${encodeURIComponent(effectiveAccount)}` : base;
  }

  private async saveSession(context: BrowserContext) {
    await context.storageState({ path: this.storageStatePath });
  }

  private async selectConfiguredAccount(page: Page) {
    const configuredAccount = (
      process.env.TRIDENT_ACCOUNT_NAME ||
      process.env.TRIDENT_BRANCH ||
      ''
    ).trim();

    if (!configuredAccount) {
      return;
    }

    logger.info(`Trident: Ensuring configured account "${configuredAccount}" is selected...`);

    const currentAccount = (
      (await page
        .locator('.cc_header_store_container, .branch-name, span.account-name')
        .first()
        .textContent()
        .catch(() => '')) || ''
    ).trim();

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
      logger.warn(`Trident: Configured account "${configuredAccount}" was not found on SelectAccount page.`);
      return;
    }

    await Promise.all([
      page.waitForLoadState('networkidle').catch(() => { }),
      accountLink.click({ timeout: 10000 }).catch(async () => {
        await accountLink.evaluate((el) => (el as HTMLElement).click());
      }),
    ]);

    await delay(1500);
  }

  private async waitForResults(page: Page) {
    await page.waitForFunction(() => {
      // Proactively clear cookie overlays if they appear during waiting
      const cookieButton = document.querySelector('#onetrust-accept-btn-handler') as HTMLElement;
      if (cookieButton && cookieButton.offsetParent !== null) {
        cookieButton.click();
      }

      const bodyText = document.body.innerText.toLowerCase();
      const items = document.querySelectorAll('.cc_product_item, .cc_row_item, .product-item').length > 0;
      const noResults =
        bodyText.includes('no results found') ||
        bodyText.includes('0 results') ||
        bodyText.includes('no matching products');
      const stillLogin = bodyText.includes("enter your details below and we'll do the rest");

      return items || noResults || stillLogin;
    }, undefined, { timeout: 30000 }).catch(() => {
      logger.warn('Trident: waitForResults timed out. Proceeding with extraction anyway.');
    });

    // Final clear before extraction
    await this.clearCookieOverlay(page).catch(() => { });
  }

  private async extractProducts(page: Page): Promise<ProductData[]> {
    return page.evaluate(() => {
      // 1. Try to find a list/table of results
      const LIST_SELECTORS = [
        '.cc_product_item',
        '.cc_row_item',
        '.product-item',
        'table.searchresults tbody tr',
        '.search-results-table tbody tr',
        'tbody tr.productRow',
        'tbody tr[class*="product"]',
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
        } catch {
          // ignore :has compatibility
        }
      }

      if (items.length > 0) {
        const products = items
          .map((item) => {
            const titleEl = item.querySelector(
              '.flexFontProductTitle, .cc_product_link, p.cc_product_link, ' +
              '.product-link, [class*="productTitle"], td a, td:first-child, .cc_product_name',
            ) as HTMLElement | null;

            const priceEl = item.querySelector(
              '.cc_price, .price, .plp-price-col, [class*="price"], ' +
              'td[class*="price"], td:nth-child(3)',
            ) as HTMLElement | null;

            const title = titleEl?.innerText.trim() || '';
            const priceText = priceEl?.innerText || '';
            const price = parseFloat(priceText.replace(/[^0-9.]/g, '') || '0') || 0;

            const text = ((item as HTMLElement).innerText || item.textContent || '').toLowerCase();
            const html = item.innerHTML.toLowerCase();

            // Regex fallback for price
            let finalPrice = price;
            if (finalPrice === 0) {
              const priceMatch = text.match(/£\s*([\d,]+\.\d{2})/);
              if (priceMatch) {
                finalPrice = parseFloat(priceMatch[1].replace(/,/g, ''));
              }
            }

            const inStock =
              text.includes('in stock') ||
              text.includes('available') ||
              html.includes('green-check') ||
              html.includes('checkmark') ||
              html.includes('check_circle') ||
              text.includes('add to basket');

            const urlEl = titleEl as HTMLAnchorElement | null;
            const url = urlEl?.href || window.location.href;
            const pipMatch = item.textContent?.match(/\b(\d{7,8})\b/);
            const pip = pipMatch ? pipMatch[1] : '';

            if (!title || title.toLowerCase() === 'product title') return null;
            return { source: 'trident', title, price: finalPrice, inStock, url, pip } as ProductData;
          })
          .filter((p): p is ProductData => Boolean(p));

        if (products.length > 0) return products;
      }

      // 2. If no list items, check if we're on a Product Detail Page (PDP)
      const pdpTitleEl = document.querySelector(
        'h1, .cc_product_title, .product-details h1, .product-details h2, .product-name',
      ) as HTMLElement | null;
      const pdpPriceEl = document.querySelector(
        '.cc_price, .product-details .price, .price, span[id*="price"], .pdp-price',
      ) as HTMLElement | null;

      if (pdpTitleEl && pdpTitleEl.innerText.trim().length > 3) {
        const title = pdpTitleEl.innerText.trim();
        const priceText = pdpPriceEl?.innerText || '0';
        const price = parseFloat(priceText.replace(/[^0-9.]/g, '') || '0') || 0;

        const bodyText = document.body.innerText.toLowerCase();
        const bodyHtml = document.body.innerHTML.toLowerCase();
        const inStock =
          bodyText.includes('in stock') ||
          bodyText.includes('item available') ||
          bodyHtml.includes('green-check') ||
          bodyHtml.includes('checkmark') ||
          bodyHtml.includes('check_circle') ||
          document.body.querySelector('.cc_stock_status, .inventory_status') !== null;

        if (price > 0 || inStock) {
          const url = window.location.href;
          const pipMatch = document.body.innerText.match(/\b(\d{7,8})\b/);
          const pip = pipMatch ? pipMatch[1] : '';
          return [{ source: 'trident', title, price, inStock, url, pip }];
        }
      }

      return [];
    });
  }

  private async saveFailureScreenshot(page: Page, query: string) {
    try {
      const screenshotPath = path.join(
        process.cwd(),
        'screenshots',
        `trident-failure-${query}-${Date.now()}.png`,
      );

      fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
      await page.screenshot({ path: screenshotPath, fullPage: true });
      logger.error(`Trident: Failure screenshot saved to ${screenshotPath}`);
    } catch (screenshotError) {
      logger.error(`Trident: Failed to capture screenshot: ${screenshotError}`);
    }
  }

  async scrape(query: string): Promise<ProductData[]> {
    const context = await this.newContext();
    const page = await context.newPage();
    await blockDumbResources(page);

    try {
      logger.info(`Trident: Starting headless scrape for query: ${query}`);

      const directUrl = this.buildDirectSearchUrl(query);
      await this.ensureAuthenticated(page, directUrl);
      await this.selectConfiguredAccount(page);
      await this.saveSession(context);

      await this.waitForResults(page).catch(() => { });

      if (await this.isLoginPage(page)) {
        logger.warn('Trident: Search redirected back to login, retrying authentication once...');
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
      logger.info(`Trident: Headless scrape complete. Found ${products.length} products.`);

      if (products.length === 0) {
        logger.warn(`Trident: No products extracted for ${query}. Capturing diagnostic screenshot.`);
        await this.saveFailureScreenshot(page, `${query}-zero-results`);
      }

      return products;
    } catch (error) {
      logger.error(`Trident: Scrape failed: ${error}`);
      await this.saveFailureScreenshot(page, query);
      throw error;
    } finally {
      await context.close();
    }
  }

  async checkAuthentication(): Promise<{ ok: boolean; message: string }> {
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

export const tridentScraper = new TridentScraper();
