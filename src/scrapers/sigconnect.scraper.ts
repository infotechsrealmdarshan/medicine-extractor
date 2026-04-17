import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Browser, Page } from 'puppeteer';
import path from 'path';
import fs from 'fs';
import { ProductData } from './mypin.scraper';
import logger from '../utils/logger';

// Add stealth plugin
puppeteer.use(StealthPlugin());

const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));
const DEFAULT_SIGCONNECT_LOGIN_URL = 'https://www.sigconnect.co.uk/login';
const DEFAULT_SIGCONNECT_SEARCH_BASE_URL = 'https://www.sigconnect.co.uk/#/search/';

export class SigConnectScraper {
  private browser: Browser | null = null;
  private readonly stateFilePath = path.join(process.cwd(), 'storage-state-sigconnect.json');
  private credentials = {
    username: (process.env.SIGCONNECT_USERNAME || 'needhammarketpharmacy@gmail.com').trim(),
    password: (process.env.SIGCONNECT_PASSWORD || 'needhaM@81').trim(),
  };

  private async launchBrowser() {
    if (!this.browser || !this.browser.isConnected()) {
      logger.debug('SigConnect: Launching Puppeteer browser...');
      this.browser = await puppeteer.launch({
        headless: true,
        protocolTimeout: 120000,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-blink-features=AutomationControlled',
          '--disable-gpu',
          '--single-process',
          '--window-size=1920,1080'
        ],
        defaultViewport: null
      });
      logger.debug('SigConnect: Browser launched successfully.');
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
      logger.info('SigConnect: Cloudflare challenge detected. PLEASE SOLVE MANUALLY if needed. Waiting up to 2 minutes...');
      // Loop to check if challenge is cleared every 2 seconds
      for (let i = 0; i < 60; i++) {
        await delay(2000);
        const stillChallenge = await page.evaluate(() => {
          const body = document.body.innerText.toLowerCase();
          return body.includes('performing security verification') ||
            body.includes('verify you are human');
        });
        if (!stillChallenge) {
          logger.info('SigConnect: Challenge cleared.');
          return;
        }
      }
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
    const scrapeStart = Date.now();
    await this.launchBrowser();
    const page = await this.browser!.newPage();

    page.on('error', (err) => logger.error(`SigConnect: Page crash/error: ${err instanceof Error ? err.message : String(err)}`));
    page.on('pageerror', (err) => logger.warn(`SigConnect: Page JS error: ${err instanceof Error ? err.message : String(err)}`));

    try {
      logger.info(`SigConnect: Starting scrape for query: ${query}`);
      await this.loadSession(page);

      const searchUrl = `${DEFAULT_SIGCONNECT_SEARCH_BASE_URL}?dt=${Date.now()}`;
      await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 45000 });
      await this.handleCloudflare(page);

      if (await this.isLoginPage(page)) {
        logger.info('SigConnect: Login required, authenticating...');
        await this.login(page);
      }

      await this.performSearchAction(page, query);
      const products = await this.extractProducts(page, query);

      const elapsed = Date.now() - scrapeStart;
      logger.info(`SigConnect: Scrape complete in ${elapsed}ms. Found ${products.length} products.`);
      if (products.length === 0) {
        logger.warn(`SigConnect: Zero products found for "${query}". Saving failure screenshot.`);
        await this.saveFailureScreenshot(page, query);
      } else {
        await this.saveSession(page);
      }

      return products;
    } catch (error) {
      const elapsed = Date.now() - scrapeStart;
      logger.error(`SigConnect scrape failed: ${error}`);
      try { await this.saveFailureScreenshot(page, query); } catch (_) { }
      if (this.browser) {
        try { await this.browser.close(); } catch (_) { }
        this.browser = null;
      }
      return [];
    } finally {
      try { await page.close(); } catch (_) { }
    }
  }

  private async performSearchAction(page: Page, query: string) {
    let filled = false;
    logger.info(`SigConnect: Triggering search for ${query} via DOM events.`);

    await page.evaluate((originalQ) => {
      // Remove leading zero if it's all numbers (as requested)
      let q = originalQ;
      if (/^0\d+$/.test(q)) {
        q = q.replace(/^0+/, '');
      }

      const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])')) as HTMLInputElement[];
      if (inputs.length > 0) {
        const isOnlyNumbers = /^\d+$/.test(q);

        let target: HTMLInputElement | undefined;
        if (isOnlyNumbers) {
          // HIGHLY SPECIFIC: Look for 110 placeholder which is unique to Pipcode
          target = inputs.find(i => (i.placeholder || '').includes('110'));

          if (!target) {
            target = inputs.find(i => {
              const label = document.querySelector(`label[for="${i.id}"]`) as HTMLElement;
              return (label?.innerText || '').toLowerCase().includes('pipcode');
            });
          }

          if (!target && inputs.length >= 2) target = inputs[1]; // Positional index 1
        } else {
          // HIGHLY SPECIFIC: Look for Keyword or index 0
          target = inputs.find(i => {
            const label = document.querySelector(`label[for="${i.id}"]`) as HTMLElement;
            const text = (label?.innerText || '').toLowerCase();
            return text.includes('keyword') || (i.placeholder || '').toLowerCase().includes('search');
          });
          if (!target) target = inputs[0];
        }

        if (target) {
          target.focus();
          target.value = '';
          target.value = q;
          ['input', 'change', 'propertychange', 'blur'].forEach(name => {
            target.dispatchEvent(new Event(name, { bubbles: true }));
          });
        }
      }
    }, query);

    // Press Enter specifically on the field we typed in
    try {
      await page.keyboard.press('Enter');
      logger.debug('SigConnect: Pressed Enter keyboard key.');
    } catch (e) {
      logger.warn('SigConnect: Failed to press Enter key.');
    }

    await this.waitForResults(page, query);
  }

  private async waitForResults(page: Page, query: string) {
    logger.info('SigConnect: Waiting for search results to appear...');
    const waitStart = Date.now();
    try {
      const initialContent = await page.evaluate(() => {
        const cat = Array.from(document.querySelectorAll('div, section')).find(el => el.textContent?.toUpperCase().includes('SIGMA CATALOGUE'));
        return cat ? cat.textContent : '';
      });

      await page.waitForFunction((q, startContent) => {
        const bodyText = document.body.innerText.toLowerCase();
        const cat = Array.from(document.querySelectorAll('div, section')).find(el => el.textContent?.toUpperCase().includes('SIGMA CATALOGUE'));
        const currentContent = cat ? cat.textContent : '';

        const hasChanged = currentContent !== startContent && currentContent?.length! > 20;

        return bodyText.includes('no products found') ||
          bodyText.includes('0 results') ||
          bodyText.includes('0 items matched') ||
          hasChanged ||
          (bodyText.includes(q.toLowerCase()) && currentContent?.includes(q));
      }, { timeout: 15000 }, query, initialContent);
      logger.debug(`SigConnect: waitForResults resolved in ${Date.now() - waitStart}ms`);
    } catch (e) {
      logger.warn('SigConnect: waitForResults timed out. Proceeding to extraction.');
    }

    logger.debug('SigConnect: Waiting 2 s for SPA to fully settle...');
    await delay(2000);
  }

  private async extractProducts(page: Page, query: string): Promise<ProductData[]> {
    logger.debug(`SigConnect: Extracting results...`);
    const results = await page.evaluate((searchQuery: string) => {
      console.log('SigConnect: Starting evaluation...');
      const found: any[] = [];
      const source = 'sigconnect';

      // Find all quantity inputs - these are the most reliable anchors for product rows
      const allInputs = Array.from(document.querySelectorAll('input[type="text"], input[type="number"], input:not([type])')) as HTMLInputElement[];
      console.log(`SigConnect: Found ${allInputs.length} total inputs.`);

      const productInputs = allInputs.filter(input => {
        const placeholder = (input.placeholder || '').toLowerCase();
        const id = (input.id || '').toLowerCase();
        const outerText = (input.parentElement?.parentElement?.innerText || '').toLowerCase();

        const isSearch = placeholder.includes('search') || placeholder.includes('keyword') ||
          placeholder.includes('pip') || id.includes('pip') ||
          id.includes('keyword') || id.includes('search') ||
          outerText.includes('keyword') || outerText.includes('pipcode');

        const isSidebar = input.closest('aside, nav, .sidebar, .menu, [id*="sidebar"], [class*="nav"]');

        // Real product inputs are usually near the end of the DOM or in the catalyst-table
        // and have a physical width that isn't the whole page
        return !isSearch && !isSidebar && input.offsetParent !== null && input.offsetWidth < 100;
      });

      console.log(`SigConnect: Identified ${productInputs.length} product-related inputs.`);

      for (const input of productInputs) {
        // Find the smallest container that looks like a row
        let row: HTMLElement | null = input.parentElement;
        let depth = 0;
        while (row && depth < 5) {
          if (row.tagName === 'TR' || (row.tagName === 'DIV' && row.innerText.length > 30)) break;
          row = row.parentElement;
          depth++;
        }

        if (!row) continue;
        const text = row.innerText || row.textContent || '';
        const lowerText = text.toLowerCase();

        // Title Extraction - the title might be in a sibling or parent if the row is split
        let titleEl = row.querySelector('b, a, strong, .name, [class*="product"], [class*="title"]');
        let title = (titleEl?.textContent || '').trim();

        // If no title in row, check the element immediately above the row (common in some Sigma layouts)
        if (!title || title.length < 5) {
          const prevText = (row.previousElementSibling as HTMLElement)?.innerText || '';
          if (prevText.length > 10 && !prevText.includes('PRODUCT')) title = prevText;
        }

        if (!title || title.toLowerCase().includes('sigma catalogue') || title.length < 5 || title.toLowerCase() === 'keyword' || title.toLowerCase() === 'pipcode') {
          const lines = text.split('\n').concat(row.parentElement?.innerText.split('\n') || []).map(l => l.trim()).filter(l => l.length > 5 && !l.toLowerCase().includes('sigma catalogue') && !l.toLowerCase().includes('keyword') && !l.includes('£'));
          title = lines[0] || '';
        }
        title = title.replace(/^[•●○\s*]+/, '').trim();
        if (title.length < 5 || title.toLowerCase().includes('my favourites') || title.toLowerCase().includes('keyword')) continue;

        const isPipMode = /^\d{7,8}$/.test(searchQuery);
        const isPipMatch = text.replace(/[^a-zA-Z0-9]/g, '').includes(searchQuery.replace(/[^a-zA-Z0-9]/g, ''));
        const isTitleMatch = title.toLowerCase().includes(searchQuery.toLowerCase());

        // Match filtering
        if (isPipMode && productInputs.length > 10 && !isPipMatch && !isTitleMatch) continue;
        if (found.some(f => f.title === title)) continue;

        // Price Extraction
        const priceEl = row.querySelector('.price, [class*="price"], .net, .amount, .total, .unit-price, td:nth-child(4), td:nth-child(5), td:nth-child(6)');
        let priceText = (priceEl?.textContent || '').trim();

        if (!priceText || !/\d/.test(priceText)) {
          // Look for specifically formatted prices like £6.27 or Net: 6.27
          const priceMatches = text.match(/£\s*(\d+\.\d{2})|Price:\s*(\d+\.\d{2})|Net:\s*(\d+\.\d{2})/i);
          if (priceMatches) {
            priceText = priceMatches[0];
          } else {
            // Broad scan for any decimal number that follows a cell containing '£' or '.'
            const cells = Array.from(row.querySelectorAll('td, div[class*="col"]'));
            for (const cell of cells) {
              const ct = (cell.textContent || '').trim();
              if (/^£?\s*\d+\.\d{2}$/.test(ct)) {
                priceText = ct;
                break;
              }
            }
          }
        }

        let price = parseFloat(priceText.replace(/[^0-9.]/g, '') || '0') || 0;

        // Global fallback if row-level fails but item is definitely found
        if (price === 0) {
          const globalMatch = document.body.innerText.match(/£\s*(\d+\.\d{2})/);
          if (globalMatch) price = parseFloat(globalMatch[1]);
        }

        const pipMatch = text.match(/PIP:\s*(\d{7,8})/i) || text.match(/\b(\d{7,8})\b/);
        let pipValue = pipMatch ? pipMatch[1] : (isPipMode ? searchQuery : '');

        const inStock = lowerText.includes('in stock') ||
          lowerText.includes('available') ||
          lowerText.includes('add to basket') ||
          row.querySelector('input') !== null;

        found.push({
          source,
          title,
          price,
          inStock,
          url: (titleEl as any)?.href || window.location.href,
          pip: pipValue
        });
      }
      return found;
    }, query);
    return results;
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
