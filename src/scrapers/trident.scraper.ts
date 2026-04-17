import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Browser, Page } from 'puppeteer';
import path from 'path';
import fs from 'fs';
import logger from '../utils/logger';
import dotenv from 'dotenv';

dotenv.config();

// Add stealth plugin
puppeteer.use(StealthPlugin());

export interface ProductData {
  source: string;
  title: string;
  price: number;
  inStock: boolean;
  url?: string;
  pip?: string;
  matchedQuery?: string;
}

const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));
const DEFAULT_TRIDENT_URL = 'https://www.tridentonline.co.uk/trident/login';
const DEFAULT_ALL_PRODUCTS_URL = 'https://www.tridentonline.co.uk/trident/AllProducts';

export class TridentScraper {
  private browser: Browser | null = null;
  private readonly storageStatePath = path.join(process.cwd(), '.trident_session', 'storage-state-puppeteer.json');

  private async launchBrowser() {
    if (!this.browser || !this.browser.isConnected()) {
      logger.debug('Trident: Launching Puppeteer browser with stealth...');
      this.browser = await (puppeteer as any).launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-blink-features=AutomationControlled',
          '--disable-gpu',
          '--window-size=1920,1080'
        ],
        defaultViewport: null
      });
      logger.debug('Trident: Browser launched successfully.');
    }
  }

  async init() {
    await this.launchBrowser();
    if (!fs.existsSync(path.dirname(this.storageStatePath))) {
      fs.mkdirSync(path.dirname(this.storageStatePath), { recursive: true });
    }
  }

  private async saveSession(page: Page) {
    const cookies = await page.cookies();
    const localStorage = await page.evaluate(() => JSON.stringify(window.localStorage));
    const sessionData = { cookies, localStorage };
    fs.writeFileSync(this.storageStatePath, JSON.stringify(sessionData, null, 2));
    logger.info('Trident: Session saved.');
  }

  private async loadSession(page: Page) {
    if (fs.existsSync(this.storageStatePath)) {
      try {
        const sessionData = JSON.parse(fs.readFileSync(this.storageStatePath, 'utf-8'));
        await page.setCookie(...sessionData.cookies);
        await page.evaluate((data) => {
          const storage = JSON.parse(data);
          for (const key in storage) {
            window.localStorage.setItem(key, storage[key]);
          }
        }, sessionData.localStorage);
        logger.info('Trident: Session loaded.');
      } catch (e) {
        logger.warn('Trident: Failed to load session.');
      }
    }
  }

  private async acceptCookies(page: Page) {
    try {
      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const acceptBtn = buttons.find(b => {
          const t = b.innerText.toLowerCase();
          return t.includes('accept all cookies') || t.includes('accept cookies') || t === 'accept';
        });
        if (acceptBtn) (acceptBtn as HTMLElement).click();
        
        const otBtn = document.querySelector('#onetrust-accept-btn-handler') as HTMLElement;
        if (otBtn) otBtn.click();
      }).catch(() => {});
      await delay(500);
    } catch {
      logger.debug('Trident: No cookie banner interaction required.');
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
    const url = page.url();
    if (url.includes('/login') || url.includes('SelectAccount')) return true;
    
    return await page.evaluate(() => {
      const bodyText = document.body.innerText;
      return bodyText.includes("Enter your details below and we'll do the rest") ||
             document.querySelector('input[name="username"]') !== null ||
             document.querySelector('input[type="password"]') !== null;
    });
  }

  private async login(page: Page) {
    const username = (process.env.TRIDENT_USERNAME || '').trim();
    const password = (process.env.TRIDENT_PASSWORD || '').trim();

    if (!username || !password) {
      throw new Error('TRIDENT_USERNAME or TRIDENT_PASSWORD is missing');
    }

    logger.info('Trident: Logging in...');
    await page.goto(DEFAULT_TRIDENT_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    await this.clearCookieOverlay(page);

    const usernameSelector = 'input[placeholder*="jane265" i], input[name="username"], input[autocomplete="username"]';
    const passwordSelector = 'input[placeholder*="Spider26" i], input[name="password"], input[type="password"]';

    await page.waitForSelector(usernameSelector, { visible: true, timeout: 20000 });
    
    await page.type(usernameSelector, username, { delay: 50 });
    await page.type(passwordSelector, password, { delay: 50 });

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
      page.evaluate(() => {
        const btn = (document.querySelector('button[type="submit"]') as HTMLElement) || 
                    (Array.from(document.querySelectorAll('button')).find(b => b.innerText.toLowerCase().includes('sign in')) as HTMLElement);
        if (btn) btn.click();
      })
    ]);

    await delay(3000);
    
    if (await this.isLoginPage(page)) {
      throw new Error('Trident login failed - still on login page');
    }
    
    await this.saveSession(page);
    logger.info('Trident: Login successful.');
  }

  private async ensureAuthenticated(page: Page, targetUrl?: string) {
    const urlToCheck = targetUrl || this.getAllProductsUrl();
    logger.info(`Trident: Checking authentication via navigation to: ${urlToCheck}`);

    await page.goto(urlToCheck, { waitUntil: 'networkidle2', timeout: 60000 });
    await this.acceptCookies(page);

    if (await this.isLoginPage(page)) {
      logger.info('Trident: Session expired or not found – authenticating...');
      await this.login(page);
      if (page.url() !== urlToCheck) {
        await page.goto(urlToCheck, { waitUntil: 'networkidle2', timeout: 60000 });
        await this.acceptCookies(page);
      }
    } else {
      logger.info(`Trident: Session is valid.`);
    }
  }

  private getAllProductsUrl(): string {
    return (process.env.TRIDENT_PRODUCTS_URL || DEFAULT_ALL_PRODUCTS_URL).trim();
  }

  private buildDirectSearchUrl(query: string): string {
    try {
      const productsUrl = this.getAllProductsUrl();
      const parsed = new URL(productsUrl);
      const searchUrl = new URL('https://www.tridentonline.co.uk/trident/searchresults');
      searchUrl.searchParams.set('operation', 'quickSearch');
      searchUrl.searchParams.set('searchText', query);
      
      // FIX: Add 'dt' parameter as requested by user. 
      searchUrl.searchParams.set('dt', Date.now().toString());

      // Carry forward session parameters
      for (const param of ['cartId', 'effectiveAccount', 'cclcl']) {
        const val = parsed.searchParams.get(param);
        if (val) searchUrl.searchParams.set(param, val);
      }
      
      return searchUrl.toString();
    } catch {
      return `https://www.tridentonline.co.uk/trident/searchresults?operation=quickSearch&searchText=${encodeURIComponent(query)}&dt=${Date.now()}`;
    }
  }

  private async selectConfiguredAccount(page: Page) {
    const configuredAccount = (process.env.TRIDENT_ACCOUNT_NAME || process.env.TRIDENT_BRANCH || '').trim();
    if (!configuredAccount) return;

    logger.info(`Trident: Ensuring configured account "${configuredAccount}" is selected...`);

    const currentAccount = await page.evaluate(() => {
      const el = document.querySelector('.cc_header_store_container, .branch-name, span.account-name');
      return el ? el.textContent?.trim() : '';
    });

    if (currentAccount?.toLowerCase().includes(configuredAccount.toLowerCase())) {
      return;
    }

    await page.goto('https://www.tridentonline.co.uk/trident/SelectAccount', { waitUntil: 'networkidle2', timeout: 60000 });
    await this.acceptCookies(page);
    await delay(1500);

    const accountFound = await page.evaluate((accName) => {
      const links = Array.from(document.querySelectorAll('a, button, span'));
      const target = links.find(l => (l as HTMLElement).innerText.toLowerCase().includes(accName.toLowerCase()));
      if (target) {
        (target as HTMLElement).click();
        return true;
      }
      return false;
    }, configuredAccount);

    if (!accountFound) {
      logger.warn(`Trident: Configured account "${configuredAccount}" not found.`);
    } else {
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
      await delay(1500);
    }
  }

  private async searchFromAllProducts(page: Page, query: string): Promise<boolean> {
    const productsUrl = this.getAllProductsUrl();
    logger.info(`Trident: Falling back to manual search on AllProducts page: ${productsUrl}`);
    
    await page.goto(productsUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await delay(2000);
    await this.acceptCookies(page);

    const SEARCH_SELECTOR = 'input[name="searchText"], input#searchCode, input[type="search"], .cc_quick_search input, input[placeholder*="search" i]';
    
    await page.waitForSelector(SEARCH_SELECTOR, { visible: true, timeout: 15000 }).catch(() => {});
    const searchInput = await page.$(SEARCH_SELECTOR);
    
    if (!searchInput) {
      logger.warn('Trident: Search input not found on AllProducts page.');
      return false;
    }

    await searchInput.click({ clickCount: 3 });
    await searchInput.type(query, { delay: 30 });
    await searchInput.press('Enter');
    
    // Check for "View all products" or direct product match in dropdown
    try {
      await new Promise(r => setTimeout(r, 1500));
      const dropdownBtn = await page.$('.view-all, [class*="view-all"], .search-results-button, .cc_quick_search_results a, a.btn-danger');
      if (dropdownBtn) {
        await dropdownBtn.click();
        logger.debug('Trident: Clicked "View all products" dropdown button.');
      }
    } catch (e) {}

    await new Promise(r => setTimeout(r, 2000));
    await this.waitForResults(page);
    return true;
  }

  private async waitForResults(page: Page) {
    logger.info('Trident: Waiting for results...');
    try {
      await page.waitForFunction(() => {
        const bodyText = document.body.innerText.toLowerCase();
        const hasItems = document.querySelector('.cc_product_item, .cc_row_item, .product-item, table.searchresults tbody tr, tbody tr.productRow') !== null;
        const noResults = bodyText.includes('no results found') || /\b0 results\b/.test(bodyText) || bodyText.includes('no matching products') || /showing\s+1\s*-\s*0\s+of\s+0/.test(bodyText);
        return hasItems || noResults;
      }, { timeout: 30000 });
    } catch (e) {
      logger.warn('Trident: waitForResults timed out.');
    }
    await this.clearCookieOverlay(page);
  }

  private async extractProducts(page: Page, query: string): Promise<ProductData[]> {
    return page.evaluate((searchQuery) => {
      const results: any[] = [];
      const LIST_SELECTORS = [
        '.cc_product_item', '.cc_row_item', '.product-item',
        'table.searchresults tbody tr', 'tbody tr.productRow',
        'tbody tr[class*="product"]', '.cc_product_listing tbody tr',
        'tr:has(td)', '.product-list div.row', '.resultsTable tbody tr'
      ];

      let items: Element[] = [];
      for (const sel of LIST_SELECTORS) {
        const found = Array.from(document.querySelectorAll(sel));
        if (found.length > 0) {
          items = found.filter(el => {
            const t = el.textContent?.toLowerCase() || '';
            return t.length > 20 && !t.includes('product title') && !t.includes('availability');
          });
          if (items.length > 0) break;
        }
      }

      items.forEach(item => {
        const titleEl = item.querySelector('.flexFontProductTitle, .cc_product_link, .product-link, [class*="productTitle"], td a, .cc_product_name') as HTMLElement | null;
        const priceEl = item.querySelector('.cc_price, .price, [class*="price"], td:nth-child(4), td:nth-child(3)') as HTMLElement | null;
        
        const text = (item as HTMLElement).innerText || '';
        const lowerText = text.toLowerCase();
        const html = item.innerHTML.toLowerCase();

        let title = titleEl?.innerText.trim() || '';
        if (!title) {
          const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 3);
          title = lines[0] || '';
        }

        const priceMatch = text.match(/£\s*([\d,]+\.\d{2})/) || text.match(/\b(\d{1,4}\.\d{2})\b/);
        const price = priceTextToFloat(priceMatch ? priceMatch[1] : (priceEl?.innerText || '0'));

        const inStock = lowerText.includes('in stock') || lowerText.includes('available') || html.includes('green-check') || lowerText.includes('add to basket');
        
        const pipMatch = text.match(/(?:Pip Code|PIP):\s*(\d{7,8})/i) || text.match(/\b(\d{7,8})\b/);
        const pip = pipMatch ? pipMatch[1] : '';

        const cleanQuery = searchQuery.replace(/[^a-zA-Z0-9]/g, '');
        const cleanProductText = text.replace(/[^a-zA-Z0-9]/g, '');
        const isPipMatch = cleanProductText.includes(cleanQuery);
        const isTitleMatch = title.toLowerCase().includes(searchQuery.toLowerCase());

        if (title.length > 5 && (price > 0 || pip.length >= 7) && (isPipMatch || isTitleMatch)) {
          results.push({
            source: 'trident',
            title: title.split(/Pip Code/i)[0].split(/AML\d+/)[0].trim(),
            price,
            inStock,
            url: (titleEl as any)?.href || window.location.href,
            pip
          });
        }
      });

      function priceTextToFloat(txt: string) {
        return parseFloat(txt.replace(/[^0-9.]/g, '') || '0');
      }

      return results;
    }, query);
  }

  async scrape(query: string): Promise<ProductData[]> {
    await this.init();
    const page = await this.browser!.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');

    try {
      logger.info(`Trident: Starting Puppeteer scrape for query: ${query}`);
      await this.loadSession(page);
      const directUrl = this.buildDirectSearchUrl(query);
      await this.ensureAuthenticated(page, directUrl);
      await this.selectConfiguredAccount(page);
      await this.waitForResults(page);
      
      let products = await this.extractProducts(page, query);
      
      if (products.length === 0) {
        logger.info(`Trident: Direct search URL yielded 0 results for ${query}. Trying manual search...`);
        const searchSuccess = await this.searchFromAllProducts(page, query);
        if (searchSuccess) {
          products = await this.extractProducts(page, query);
        }
      }

      logger.info(`Trident: Scrape complete. Found ${products.length} products.`);
      
      if (products.length > 0) {
        await this.saveSession(page);
      }
      
      return products;
    } catch (error) {
      logger.error(`Trident: Scrape failed: ${error}`);
      return [];
    } finally {
      await page.close();
    }
  }

  async checkAuthentication(): Promise<{ ok: boolean; message: string }> {
    await this.init();
    const page = await this.browser!.newPage();
    try {
      await this.ensureAuthenticated(page);
      return { ok: true, message: 'Trident authentication succeeded' };
    } catch (error) {
      return { ok: false, message: String(error) };
    } finally {
      await page.close();
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
