import { firefox } from 'playwright';
import type { Browser } from 'playwright';
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

const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

export class MyPinScraper {
  private browser: Browser | null = null;

  async init() {
    if (!this.browser || !this.browser.isConnected()) {
      this.browser = await firefox.launch({
        headless: true,
      });
    }
  }

  private async newContextWithRetry() {
    await this.init();

    try {
      return await this.browser!.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes('has been closed')) {
        logger.warn('MyPin: Browser context was closed. Relaunching browser...');
        this.browser = null;
        await this.init();
        return this.browser!.newContext({
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        });
      }
      throw error;
    }
  }

  async scrape(query: string): Promise<ProductData[]> {
    const context = await this.newContextWithRetry();
    const page = await context.newPage();

    try {
      logger.info(`Starting scrape for query: ${query}`);

      // 1. Login with retry
      const loginUrl = 'https://www.myp-i-n.co.uk/pms/servlet/twaaserver?svcname=pmsacu&usrurl=../design&usrfunc=LO';
      let loginSuccess = false;
      for (let i = 0; i < 2; i++) {
        try {
          logger.info(`Navigation attempt ${i + 1} to ${loginUrl}`);
          await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
          loginSuccess = true;
          break;
        } catch (e) {
          logger.warn(`Navigation attempt ${i + 1} failed: ${e}`);
          if (i === 1) throw e;
        }
      }

      await page.waitForSelector('input[name="cuf_id"]', { timeout: 20000 });
      await page.fill('input[name="cuf_id"]', process.env.SUPPLIER_USERNAME || '');
      await page.fill('input[name="cuf_passwd"]', process.env.SUPPLIER_PASSWORD || '');
      await page.click('input[type="image"]'); // Confirm button image

      logger.info('Login submitted');

      // 2. Handle "Continue" or redirect
      try {
        await page.waitForSelector('input[value="Continue"]', { timeout: 5000 });
        await page.click('input[value="Continue"]');
        logger.info('Clicked Continue button');
      } catch (e) {
        logger.info('Continue button not found or already redirected');
      }

      // 3. Search with retry
      const searchUrl = 'https://www.myp-i-n.co.uk/pms/servlet/eboserver?svcname=e10h009&usrurl=../design';
      for (let i = 0; i < 2; i++) {
        try {
          await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
          break;
        } catch (e) {
          logger.warn(`Search page navigation attempt ${i + 1} failed: ${e}`);
          if (i === 1) throw e;
        }
      }

      // Detect if PIP code (7 or 8 digits)
      const isPipCode = /^\d{7,8}$/.test(query);

      if (isPipCode) {
        logger.info(`Detected PIP code: ${query}`);
        await page.waitForSelector('input[name="art_search"]', { timeout: 10000 });
        await page.fill('input[name="art_search"]', query);
        await page.keyboard.press('Enter');
      } else {
        logger.info(`Detected keyword search: ${query}`);
        await page.waitForSelector('input[name="search_words"]', { timeout: 10000 });
        await page.fill('input[name="search_words"]', query);
        await page.keyboard.press('Enter');
      }

      logger.info(`Search for ${query} submitted`);

      // 4. Extract
      try {
        // Wait for either the results table or an error message
        await Promise.race([
          page.waitForSelector('table', { timeout: 15000 }),
          page.waitForSelector('text=Not Known', { timeout: 15000 }),
          page.waitForSelector('text=No matching products', { timeout: 15000 }),
        ]);
      } catch (e) {
        logger.info(`No results found or timeout for ${query}`);
        return [];
      }

      // Check for error text
      const isNotFound = await page.evaluate(() => {
        return document.body.innerText.includes('Is Not Known') ||
               document.body.innerText.includes('No matching products found');
      });

      if (isNotFound) {
        logger.info(`Product not found for query: ${query}`);
        return [];
      }

      const products = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('table tr'));
        if (rows.length === 0) return [];

        // 1. Detect if this is a "Detail View" (vertical table)
        // Detail views usually have "Description" or "PIP Code" in the first column of one of the first few rows
        const isDetailView = rows.some(row => {
          const firstCellText = row.querySelector('td')?.innerText.trim() || '';
          return firstCellText === 'PIP Code' || firstCellText === 'Description';
        });

        if (isDetailView) {
          const data: Record<string, string> = {};
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
          if (cells.length < 8) return null; // Need at least index 7 for Availability

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
        }).filter(p => p !== null) as any[];
      });

      logger.info(`Extracted ${products.length} products`);
      return products;

    } catch (error) {
      const timestamp = new Date().getTime();
      const screenshotPath = path.join(process.cwd(), 'screenshots', `failure-${timestamp}.png`);
      await page.screenshot({ path: screenshotPath });
      logger.error(`Scraping failed: ${error}. Screenshot saved to ${screenshotPath}`);
      return [];
    } finally {
      await context.close();
    }
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
    }
  }
}

export const myPinScraper = new MyPinScraper();
