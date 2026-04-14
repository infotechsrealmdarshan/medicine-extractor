import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Browser, Page } from 'puppeteer';
import path from 'path';
import fs from 'fs';
import { ProductData } from './mypin.scraper';
import logger from '../utils/logger';

// Add stealth plugin
puppeteer.use(StealthPlugin());

const DEFAULT_SIGCONNECT_LOGIN_URL = 'https://www.sigconnect.co.uk/login';
const DEFAULT_SIGCONNECT_SEARCH_URL = 'https://www.sigconnect.co.uk/#/search/';

export class SigConnectScraper {
  private browser: Browser | null = null;
  private readonly stateFilePath = path.join(process.cwd(), 'storage-state-sigconnect.json');
  private credentials = {
    username: (process.env.SIGCONNECT_USERNAME || 'needhammarketpharmacy@gmail.com').trim(),
    password: (process.env.SIGCONNECT_PASSWORD || 'needhaM@81').trim(),
  };

  private async launchBrowser() {
    if (!this.browser || !this.browser.isConnected()) {
      this.browser = await puppeteer.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-blink-features=AutomationControlled',
          '--window-size=1920,1080'
        ],
        defaultViewport: null
      });
    }
  }

  private async isLoginPage(page: Page): Promise<boolean> {
    const url = page.url();
    if (url.includes('/login')) return true;
    return (await page.$('#loginform-username')) !== null;
  }

  private async handleCloudflare(page: Page) {
    const isChallenge = await page.evaluate(() => {
      const body = document.body.innerText.toLowerCase();
      return body.includes('performing security verification') ||
        body.includes('verify you are human') ||
        body.includes('verification is taking longer than expected');
    });

    if (isChallenge) {
      logger.info('SigConnect (Puppeteer): Cloudflare challenge detected. Waiting...');
      await page.waitForFunction(() => {
        const body = document.body.innerText.toLowerCase();
        return !body.includes('performing security verification') &&
          !body.includes('verify you are human') &&
          (document.querySelector('#loginform-username') !== null || document.location.href.includes('search'));
      }, { timeout: 60000 }).catch(() => {
        logger.warn('SigConnect: Cloudflare challenge wait timed out.');
      });
    }
  }

  private async saveSession(page: Page) {
    const cookies = await page.cookies();
    const localStorage = await page.evaluate(() => JSON.stringify(window.localStorage));
    const sessionData = { cookies, localStorage };
    fs.writeFileSync(this.stateFilePath, JSON.stringify(sessionData, null, 2));
    logger.info('SigConnect: Session saved.');
  }

  private async loadSession(page: Page) {
    if (fs.existsSync(this.stateFilePath)) {
      try {
        const sessionData = JSON.parse(fs.readFileSync(this.stateFilePath, 'utf-8'));
        await page.setCookie(...sessionData.cookies);
        await page.evaluate((data) => {
          const storage = JSON.parse(data);
          for (const key in storage) {
            window.localStorage.setItem(key, storage[key]);
          }
        }, sessionData.localStorage);
        logger.info('SigConnect: Session loaded.');
      } catch (e) {
        logger.warn('SigConnect: Failed to load session.');
      }
    }
  }

  private async login(page: Page) {
    logger.info('SigConnect: Starting authentication...');
    await page.goto(DEFAULT_SIGCONNECT_LOGIN_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    await this.handleCloudflare(page);

    await page.waitForSelector('#loginform-username', { visible: true, timeout: 30000 }).catch(() => { });

    if (await page.$('#loginform-username')) {
      await page.type('#loginform-username', this.credentials.username, { delay: 50 });
      await page.type('#loginform-password', this.credentials.password, { delay: 50 });
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => { }),
        page.click('#login_btn')
      ]);
      logger.info('SigConnect: Login submitted.');
    }

    await page.waitForFunction(() => document.location.href.includes('/#/') || document.location.href.includes('search'), { timeout: 30000 }).catch(() => { });
    await this.saveSession(page);
    logger.info('SigConnect: Authenticated.');
  }

  async scrape(query: string): Promise<ProductData[]> {
    await this.launchBrowser();
    const page = await this.browser!.newPage();

    try {
      logger.info(`SigConnect (Puppeteer): Starting scrape for query: ${query}`);
      await this.loadSession(page);

      await page.goto(DEFAULT_SIGCONNECT_SEARCH_URL, { waitUntil: 'networkidle2', timeout: 30000 });
      await this.handleCloudflare(page);

      if (await this.isLoginPage(page)) {
        await this.login(page);
        if (page.url() !== DEFAULT_SIGCONNECT_SEARCH_URL) {
          await page.goto(DEFAULT_SIGCONNECT_SEARCH_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        }
      }

      await this.performSearchAction(page, query);
      const products = await this.extractProducts(page, query);

      logger.info(`SigConnect: Scrape complete. Found ${products.length} products.`);
      if (products.length === 0) await this.saveFailureScreenshot(page, query);
      else await this.saveSession(page);

      return products;
    } catch (error) {
      logger.error(`SigConnect (Puppeteer) scrape failed: ${error}`);
      await this.saveFailureScreenshot(page, query);
      return [];
    } finally {
      await page.close();
    }
  }

  private async performSearchAction(page: Page, query: string) {
    const isPipCode = /^\d{7,8}$/.test(query);
    logger.info(`SigConnect: Entering ${query} into ${isPipCode ? 'Pipcode' : 'Keyword'} field.`);

    // Use hardcoded indices for the input fields as the layout is very consistent
    // Index 0: Keyword, Index 1: Pipcode, Index 2: Product code
    const targetIndex = isPipCode ? 1 : 0;

    const found = await page.evaluate((index) => {
      const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'));
      // Filter to only include the main search row inputs (they have placeholders like "Type..." or "110...")
      const searchInputs = inputs.filter(inp => {
        const ph = inp.getAttribute('placeholder') || '';
        return ph.includes('Type') || ph.includes('110') || ph.includes('Sig') || inp.id.includes('keyword') || inp.id.includes('pip');
      });

      const target = searchInputs[index];
      if (target) {
        (target as HTMLInputElement).focus();
        (target as HTMLInputElement).value = '';
        return true;
      }
      return false;
    }, targetIndex);

    if (found) {
      // Puppeteer keyboard actions are more reliable for triggering Angular search events
      await page.keyboard.down('Control');
      await page.keyboard.press('A');
      await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');
      // Capture initial state BEFORE search to detect change accurately
      const initialState = await page.evaluate(() => {
        const cat = Array.from(document.querySelectorAll('div, section')).find(el => el.textContent?.toUpperCase().includes('SIGMA CATALOGUE')) as HTMLElement;
        return cat ? cat.innerText : '';
      });

      await page.keyboard.type(query, { delay: 40 });
      await page.keyboard.press('Enter');

      // Wait for the UI to update
      await this.waitForResults(page, initialState);
    } else {
      // Final desperate fallback
      const selector = isPipCode ? 'input[placeholder*="110"]' : 'input[placeholder*="Type"]';
      const input = await page.$(selector);
      if (input) {
        await input.click({ clickCount: 3 });
        await input.type(query, { delay: 40 });
        await input.press('Enter');
      }
    }
  }

  private async waitForResults(page: Page, initialState: string = '') {
    logger.info('SigConnect: Waiting for search results to appear...');
    try {
      await page.waitForFunction((oldText: string) => {
        const bodyText = document.body.innerText.toLowerCase();

        // Look for the catalogue container
        const catalogue = Array.from(document.querySelectorAll('div, section, table')).find(el =>
          el.textContent?.toUpperCase().includes('SIGMA CATALOGUE')
        );

        if (!catalogue) return false;

        // Check for "no results"
        const noResults = bodyText.includes('no products found') ||
          bodyText.includes('no results matching') ||
          bodyText.includes('0 results found') ||
          bodyText.includes('no records matching');
        if (noResults) return true;

        // Check if content has changed from initial state and looks like product data
        const currentText = (catalogue as HTMLElement).innerText || '';
        const hasChanged = oldText && currentText.length > 20 && currentText !== oldText;

        // Check for presence of product-like elements (rows with data)
        const hasProducts = Array.from(catalogue.querySelectorAll('tr, .sigma-catalogue-item, [ng-repeat*="product"], div.row')).some((el: Element) => {
          const t = el.textContent?.toLowerCase() || '';
          return t.length > 30 && !t.includes('keyword') && !t.includes('search');
        });

        return hasChanged || hasProducts;
      }, { timeout: 12000 }, initialState);
    } catch (e) {
      logger.warn('SigConnect: waitForResults timed out or failed. Proceeding to extraction.');
    }

    // Longer buffer for Angular/SPA updates to finish settling
    await page.evaluate(() => new Promise(r => setTimeout(r, 2500)));
  }

  private async extractProducts(page: Page, query: string): Promise<ProductData[]> {
    return page.evaluate((query: string) => {
      const found: any[] = [];
      const source = 'sigconnect';

      // 1. Identify the search results area
      const containers = Array.from(document.querySelectorAll('div, section, .panel, .widget, table')).filter(el =>
        el.textContent?.toUpperCase().includes('SIGMA CATALOGUE')
      );

      const resultsArea = containers[containers.length - 1] || document.body;

      // 2. Comprehensive row detection
      // We look for elements that look like a product row (name + price or icon or pip)
      const allElements = Array.from(resultsArea.querySelectorAll('tr, .sigma-catalogue-item, [ng-repeat*="product"], .product-row, .item-row, div.row'));

      const rows = allElements.filter((el: Element) => {
        const text = (el as HTMLElement).innerText || el.textContent || '';
        const lowerText = text.toLowerCase();

        // Skip if too short or clearly a header/field
        if (text.length < 20) return false;
        if (lowerText.includes('keyword') || lowerText.includes('pipcode')) return false;
        if (lowerText.includes('product') && lowerText.includes('pack') && lowerText.includes('inv.')) return false;

        // Must have some product-like content (digits for price/pip or stock indicator)
        return /\d/.test(text) || el.querySelector('button, input, .success, .green, .red, img');
      });

      const seenTitles = new Set();

      for (const el of rows) {
        const text = (el as HTMLElement).innerText || el.textContent || '';
        const lowerText = text.toLowerCase();

        // Extract Title - be very aggressive finding the name
        // Usually the first bold element or the first line of text
        const titleEl = el.querySelector('b, a, .product-name, [class*="title"], strong, h4, h3, .name');
        let title = '';

        if (titleEl) {
          title = titleEl.textContent?.trim() || '';
        }

        if (!title || title.length < 5) {
          // Fallback: take the first long line
          const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 5);
          title = lines[0] || '';
        }

        // Clean title
        title = title.replace(/^[•●○\s*]+/, '').trim();
        // Remove trailing "In Stock" or similar if concatenated
        title = title.replace(/\s+(In Stock|Out of Stock|More info|Add).*$/i, '').trim();

        if (!title || title.length < 5 || seenTitles.has(title)) continue;

        // Extract Price
        let price = 0;
        // Look for £ symbol or pure digit patterns like 10.50
        const priceMatch = text.match(/£\s*([\d,]+\.\d{2})/) ||
          text.match(/(\d+[,.]\d{2})\b/) ||
          text.match(/price:?\s*£?\s*([\d.]+)/i);
        if (priceMatch) {
          price = parseFloat(priceMatch[1].replace(/,/g, ''));
        }

        // Extract Stock
        const html = el.innerHTML.toLowerCase();
        const inStock = html.includes('green') ||
          html.includes('success') ||
          html.includes('check') ||
          html.includes('dot') ||
          lowerText.includes('in stock') ||
          lowerText.includes('available') ||
          lowerText.includes('inv:') ||
          (!html.includes('red') && !lowerText.includes('out of stock') && !lowerText.includes('0 inv'));

        // Extract PIP
        const pipMatch = text.match(/PIP:\s*(\d{7,8})/i) || text.match(/\b(\d{7,8})\b/);
        const pip = pipMatch ? pipMatch[1] : (query.match(/^\d{7,8}$/) ? query : '');

        found.push({
          source,
          title,
          price,
          inStock,
          url: (titleEl as any)?.href || window.location.href,
          pip
        });
        seenTitles.add(title);
      }

      // Final fallback if extraction was too strict but we see something
      const resultsAreaHtml = resultsArea as HTMLElement;
      if (found.length === 0 && resultsAreaHtml.innerText && resultsAreaHtml.innerText.length > 100) {
        const lines = resultsAreaHtml.innerText.split('\n').filter((l: string) => l.trim().length > 10);
        // If we found a line that looks like a product name and we had no results
        for (const line of lines) {
          if (line.toLowerCase().includes(query) || (query.length > 5 && line.length > 15 && !line.includes('Search'))) {
            found.push({
              source,
              title: line.trim(),
              price: 0,
              inStock: true,
              url: window.location.href,
              pip: query.match(/^\d{7,8}$/) ? query : ''
            });
            break;
          }
        }
      }

      return found;
    }, query);
  }

  private async saveFailureScreenshot(page: Page, query: string) {
    const screenshotPath = path.join(process.cwd(), 'screenshots', `sigconnect-failure-${query}-${Date.now()}.png`);
    if (!fs.existsSync(path.dirname(screenshotPath))) fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => { });
    logger.warn(`SigConnect: Failure screenshot saved to ${screenshotPath}`);
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}

export const sigConnectScraper = new SigConnectScraper();
