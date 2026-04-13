import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';
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

const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

export class MyPinScraper {
  private browser: Browser | null = null;
  private readonly storageStatePath = path.join(process.cwd(), '.mypin_session.json');

  async init() {
    if (!this.browser || !this.browser.isConnected()) {
      this.browser = await chromium.launch({
        headless: true,
        args: ['--disable-blink-features=AutomationControlled'],
      });
    }
    const dir = path.dirname(this.storageStatePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  private async newContextWithRetry(): Promise<BrowserContext> {
    await this.init();

    try {
      return await this.browser!.newContext({
        storageState: fs.existsSync(this.storageStatePath) ? this.storageStatePath : undefined,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes('has been closed')) {
        logger.warn('MyPin: Browser context was closed. Relaunching browser...');
        this.browser = null;
        await this.init();
        return this.browser!.newContext({
          storageState: fs.existsSync(this.storageStatePath) ? this.storageStatePath : undefined,
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        });
      }
      throw error;
    }
  }

  async scrape(query: string): Promise<ProductData[]> {
    const context = await this.newContextWithRetry();
    const page = await context.newPage();
    await blockDumbResources(page);

    try {
      logger.info(`Starting MyPin scrape for query: ${query}`);

      const searchUrl = 'https://www.myp-i-n.co.uk/pms/servlet/eboserver?svcname=e10h009&usrurl=../design';
      
      // Step 1: Try direct navigation to search (Optimistic)
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // Detect if we are redirected to login
      if (await page.locator('input[name="cuf_id"]').count() > 0) {
        logger.info('MyPin: Session expired, logging in...');
        await this.login(page);
        await context.storageState({ path: this.storageStatePath });
        
        // Return to search
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      }

      // Step 2: Perform search
      const isPipCode = /^\d{7,8}$/.test(query);
      if (isPipCode) {
        await page.waitForSelector('input[name="art_search"]', { timeout: 10000 });
        await page.fill('input[name="art_search"]', query);
        await page.keyboard.press('Enter');
      } else {
        await page.waitForSelector('input[name="search_words"]', { timeout: 10000 });
        await page.fill('input[name="search_words"]', query);
        await page.keyboard.press('Enter');
      }

      // Step 3: Extract
      try {
        await Promise.race([
          page.waitForSelector('table', { timeout: 15000 }),
          page.waitForSelector('text=Not Known', { timeout: 15000 }),
          page.waitForSelector('text=No matching products', { timeout: 15000 }),
        ]);
      } catch (e) {
        logger.info(`MyPin: No results found or timeout for ${query}`);
        return [];
      }

      const isNotFound = await page.evaluate(() => {
        const text = document.body.innerText;
        return text.includes('Is Not Known') || text.includes('No matching products found');
      });

      if (isNotFound) return [];

      const products = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('table tr'));
        if (rows.length === 0) return [];

        const isDetailView = rows.some(row => {
          const firstCellText = row.querySelector('td')?.innerText.trim() || '';
          return firstCellText === 'PIP Code' || firstCellText === 'Description';
        });

        if (isDetailView) {
          const data: Record<string, string> = {};
          rows.forEach(row => {
            const cells = row.querySelectorAll('td');
            if (cells.length >= 2) {
              data[cells[0].innerText.trim()] = cells[1].innerText.trim();
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
              url: window.location.href,
              pip: data['PIP Code'] || '',
            } as ProductData];
          }
        }

        return rows.slice(1).map((row) => {
          const cells = row.querySelectorAll('td');
          if (cells.length < 8) return null;
          const title = cells[1]?.innerText.trim() || 'Unknown';
          const priceStr = cells[4]?.innerText.trim() || cells[3]?.innerText.trim() || cells[2]?.innerText.trim() || '0.00';
          const price = parseFloat(priceStr.replace(/[^0-9.]/g, '')) || 0;
          const stockStr = cells[7]?.innerText.trim() || '';
          const inStock = stockStr.toLowerCase().includes('in stock') ||
            (stockStr.toLowerCase().includes('available') && !stockStr.toLowerCase().includes('not available'));
          return {
            source: 'myp-i-n',
            title,
            price,
            inStock,
            url: window.location.href,
            pip: cells[0]?.innerText.trim() || '',
          } as ProductData;
        }).filter((p): p is ProductData => p !== null);
      });

      return products;
    } catch (error) {
      logger.error(`MyPin: Scraping failed: ${error}`);
      return [];
    } finally {
      await context.close();
    }
  }

  private async login(page: Page) {
    const loginUrl = 'https://www.myp-i-n.co.uk/pms/servlet/twaaserver?svcname=pmsacu&usrurl=../design&usrfunc=LO';
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
    
    await page.waitForSelector('input[name="cuf_id"]');
    await page.fill('input[name="cuf_id"]', (process.env.SUPPLIER_USERNAME || '').trim());
    await page.fill('input[name="cuf_passwd"]', (process.env.SUPPLIER_PASSWORD || '').trim());
    await page.click('input[type="image"]');

    try {
      await page.waitForSelector('input[value="Continue"]', { timeout: 5000 });
      await page.click('input[value="Continue"]');
    } catch (e) {
      // ignore
    }
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}

export const myPinScraper = new MyPinScraper();
