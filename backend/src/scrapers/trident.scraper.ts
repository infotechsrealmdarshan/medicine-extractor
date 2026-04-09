import { chromium, Browser, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import logger from '../utils/logger';
import dotenv from 'dotenv';

dotenv.config();

export interface ProductData {
  source: string;
  title: string;
  price: number;
  inStock: boolean;
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
        await oneTrustAccept.click({ timeout: 3000 }).catch(() => {});
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
          await button.click({ timeout: 3000 }).catch(() => {});
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
    }).catch(() => {});
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
      'input[placeholder*="jane265"], input[name="username"], input[type="text"]',
    ).first();
    if (!(await usernameLocator.isVisible().catch(() => false))) {
      // Some hub routes do not render the login form directly; force the explicit login page.
      await page.goto(DEFAULT_TRIDENT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await this.acceptCookies(page);
    }

    const usernameField = page.locator('input[placeholder*="jane265"], input[name="username"], input[type="text"]').first();
    const passwordField = page.locator('input[placeholder*="Spider26"], input[name="password"], input[type="password"]').first();

    await usernameField.waitFor({ state: 'visible', timeout: 20000 });
    await passwordField.waitFor({ state: 'visible', timeout: 20000 });

    await usernameField.click({ timeout: 5000 }).catch(() => {});
    await usernameField.fill(username);
    await usernameField.press('Tab').catch(() => {});

    await passwordField.click({ timeout: 5000 }).catch(() => {});
    await passwordField.fill(password);
    await passwordField.press('Tab').catch(() => {});

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
        page.waitForURL((url) => !url.href.includes('login') && !url.href.includes('SelectAccount'), { timeout: 15000 }).catch(() => {}),
        signInButton.click({ timeout: 10000 }),
      ]);
    } catch (clickError) {
      const message = clickError instanceof Error ? clickError.message.toLowerCase() : String(clickError).toLowerCase();
      if (message.includes('intercepts pointer events') || message.includes('timeout')) {
        logger.warn('Trident: Sign-in click blocked, clearing cookie overlay and retrying...');
        await this.clearCookieOverlay(page);

        await Promise.all([
          page.waitForURL((url) => !url.href.includes('login') && !url.href.includes('SelectAccount'), { timeout: 15000 }).catch(() => {}),
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

  private async ensureAuthenticated(page: Page) {
    const loginUrl = process.env.TRIDENT_URL || DEFAULT_TRIDENT_URL;
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await this.acceptCookies(page);

    // If custom hub URL does not present login/authenticated state clearly, fall back to explicit Trident login page.
    if (!(await this.isLoginPage(page))) {
      const hasKnownAuthenticatedMarkers =
        (await page.locator('.cc_header_store_container, .branch-name, span.account-name').count().catch(() => 0)) > 0;
      if (!hasKnownAuthenticatedMarkers) {
        await page.goto(DEFAULT_TRIDENT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await this.acceptCookies(page);
      }
    }

    if (await this.isLoginPage(page)) {
      await this.login(page);
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
    await page.goto(productsUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await this.acceptCookies(page);

    if (await this.isLoginPage(page)) {
      return false;
    }

    const searchInput = page
      .locator(
        'input[name="searchText"], input#searchCode, input[type="search"], .cc_quick_search input, .cc_search_input, input[placeholder*="search"]',
      )
      .first();

    if ((await searchInput.count()) === 0) {
      logger.warn('Trident: Search input not found on AllProducts page.');
      return false;
    }

    await searchInput.waitFor({ state: 'visible', timeout: 15000 });
    await searchInput.fill(query);
    await searchInput.press('Enter').catch(() => {});

    const searchButton = page
      .locator('button[type="submit"], .cc_quick_search button, [class*="search"] button')
      .first();
    if ((await searchButton.count()) > 0) {
      await searchButton.click({ timeout: 5000 }).catch(() => {});
    }

    await page.waitForLoadState('networkidle').catch(() => {});
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
      page.waitForLoadState('networkidle').catch(() => {}),
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
    }, { timeout: 30000 }).catch(() => {
      logger.warn('Trident: waitForResults timed out. Proceeding with extraction anyway.');
    });
    
    // Final clear before extraction
    await this.clearCookieOverlay(page).catch(() => {});
  }

  private async extractProducts(page: Page): Promise<ProductData[]> {
    return page.evaluate(() => {
      const items = Array.from(
        document.querySelectorAll('.cc_product_item, .cc_row_item, .product-item'),
      );

      const products = items
        .map((item) => {
          const titleEl = item.querySelector(
            '.flexFontProductTitle, .cc_product_link, p.cc_product_link, .product-link, [class*="productTitle"]',
          ) as HTMLElement | null;
          const priceEl = item.querySelector(
            '.cc_price, .price, .plp-price-col, [class*="price"]',
          ) as HTMLElement | null;

          const title = titleEl?.innerText.trim() || '';
          const price = parseFloat(priceEl?.innerText.replace(/[^0-9.]/g, '') || '0') || 0;
          const text = (item.textContent || '').toLowerCase();
          const html = item.innerHTML.toLowerCase();
          const inStock =
            text.includes('in stock') ||
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
        .filter((product): product is ProductData => Boolean(product));

      return products.filter(
        (product, index, self) =>
          index === self.findIndex((candidate) => candidate.title === product.title),
      );
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

    try {
      logger.info(`Trident: Starting headless scrape for query: ${query}`);

      await this.ensureAuthenticated(page);
      await this.selectConfiguredAccount(page);
      await this.saveSession(context);

      const allProductsSearchWorked = await this.searchFromAllProducts(page, query);
      if (!allProductsSearchWorked) {
        logger.warn('Trident: AllProducts search path failed, falling back to direct search URL.');
        const fallbackUrl = this.buildDirectSearchUrl(query);
        await page.goto(fallbackUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await this.acceptCookies(page);
      }

      await this.waitForResults(page).catch(() => {});

      if (await this.isLoginPage(page)) {
        logger.warn('Trident: Search redirected back to login, retrying authentication once...');
        await this.login(page);
        await this.saveSession(context);
        const retryUrl = this.buildDirectSearchUrl(query);
        await page.goto(retryUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await this.waitForResults(page).catch(() => {});
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
