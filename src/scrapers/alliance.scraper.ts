import { chromium, Browser, Page, BrowserContext } from 'playwright';
import path from 'path';
import fs from 'fs';
import { ProductData } from './mypin.scraper';
import logger from '../utils/logger';
import { blockDumbResources } from '../utils/playwright-utils';

export class AllianceScraper {
  private browser: Browser | null = null;
  private stateFilePath = path.join(process.cwd(), 'storage-state-alliance.json');
  private credentials = {
    username: (process.env.ALLIANCE_USERNAME || 'pharmacy.fn841@nhs.net').trim(),
    password: (process.env.ALLIANCE_PASSWORD || 'Needham1#').trim(),
  };
  private loginUrl = process.env.ALLIANCE_LOGIN_URL || 'https://www.myahportal.co.uk/login';
  private handoffUrl = 'https://www.myahportal.co.uk/customer/ahdirect';

  private async init() {
    if (!this.browser || !this.browser.isConnected()) {
      this.browser = await chromium.launch({
        headless: true,
        args: ['--disable-blink-features=AutomationControlled'],
      });
    }
  }

  async scrape(query: string): Promise<ProductData[]> {
    await this.init();
    let context: BrowserContext | null = null;

    try {
      const hasState = fs.existsSync(this.stateFilePath);
      context = await this.browser!.newContext(
        hasState
          ? { storageState: this.stateFilePath, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
          : { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
      );

      const page = await context.newPage();
      await blockDumbResources(page);

      // Navigate to login if no state, or attempt direct search
      if (!hasState) {
        await this.login(page);
        await context.storageState({ path: this.stateFilePath });
      }

      let products = await this.performSearch(page, query);

      // If search failed (redirected to login or timeout), state might be expired
      if (products === null) {
        logger.warn('Alliance: Search failed or session expired. Re-authenticating...');
        if (fs.existsSync(this.stateFilePath)) {
          try { fs.unlinkSync(this.stateFilePath); } catch (e) { /* ignore */ }
        }
        await this.login(page);
        await context.storageState({ path: this.stateFilePath });
        products = await this.performSearch(page, query);
      }

      return products || [];
    } catch (error) {
      logger.error(`Alliance scraper failed: ${error}`);
      return [];
    } finally {
      if (context) await context.close();
    }
  }

  private async login(page: Page) {
    logger.info('Alliance: Starting authentication...');
    await page.goto(this.loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Handle splash page "Login" button if it exists
    const loginLink = await page.$('.loginlink, a[href="#login"], #Login, .login-btn');
    if (loginLink) {
        logger.info('Alliance: Clicking splash login button...');
        await loginLink.click();
    }

    // Clear common cookie banners
    await page.click('button:has-text("Accept"), button:has-text("Agree"), #onetrust-accept-btn-handler').catch(() => { });

    // Fill credentials
    const userField = await page.waitForSelector('#username', { state: 'visible', timeout: 10000 });
    if (userField) {
        await page.fill('#username', this.credentials.username);
        await page.fill('#password', this.credentials.password);
        await Promise.all([
          page.waitForURL(url => !url.href.includes('login'), { timeout: 20000 }).catch(() => {}),
          page.click('button[type="submit"], #_submit, button:has-text("Login")')
        ]);
    }

    // Establishing session on direct portal (Crucial step)
    logger.info('Alliance: Establishing session on direct portal via handoff URL...');
    await page.goto(this.handoffUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    // Wait for a key indicator that we are in the portal
    await page.waitForSelector('input#search, .resultsTable, #main-content', { timeout: 20000 }).catch(() => {
      logger.warn('Alliance: Handoff indicator not found, but proceeding...');
    });
    
    logger.info('Alliance: Authenticated and session established.');
  }

  private async performSearch(page: Page, query: string): Promise<ProductData[] | null> {
    const searchUrl = `https://direct.alliance-healthcare.co.uk/uni2/members/orders/productsearch2.asp?search=${encodeURIComponent(query)}`;
    logger.info(`Alliance: Accessing search url -> ${searchUrl}`);

    const res = await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Detect login redirect or timeout
    if (page.url().includes('login') || page.url().includes('timeout') || (res && res.status() >= 400 && res.status() !== 404)) {
      return null;
    }

    // Wait for the results table or the "no results" message
    await page.waitForSelector('.resultsTable, :text("no results"), :text("0 matching")', { timeout: 15000 }).catch(() => {});

    return page.evaluate(() => {
      const results: ProductData[] = [];
      const rows = Array.from(document.querySelectorAll('.resultsTable tbody tr'));
      
      if (rows.length === 0) {
          // Fallback to broader row detection if class is missing
          const allRows = Array.from(document.querySelectorAll('tr'));
          for (const row of allRows) {
              const text = (row.textContent || '').toLowerCase();
              if (text.includes('pip:') || text.includes('ean:')) {
                  rows.push(row);
              }
          }
      }

      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll('td'));
        if (cells.length < 5) continue;

        const rawText = (row as HTMLElement).innerText || row.textContent || '';
        
        // Product Title from 1st cell (usually contains <b><a ...>)
        const firstCell = cells[0];
        const titleEl = firstCell.querySelector('b, a');
        const title = titleEl ? titleEl.textContent?.trim() : 'Alliance Product';

        // Extract PIP from text
        const pipMatch = rawText.match(/PIP:\s*(\d{7,8})/i);
        const pip = pipMatch ? pipMatch[1] : '';

        // Extract price (look for id and content)
        const priceCell = row.querySelector('[id^="price"]');
        let price = 0;
        const priceText = priceCell ? priceCell.textContent || '' : rawText;
        const priceMatch = priceText.match(/([\d,]+\.\d{2})/);
        if (priceMatch) {
          price = parseFloat(priceMatch[1].replace(/,/g, ''));
        }

        // Determine stock based on green circle image
        const html = row.innerHTML.toLowerCase();
        const inStock =
          html.includes('greenbutton.gif') ||
          html.includes('green-check') ||
          html.includes('in stock') ||
          rawText.toLowerCase().includes('add to basket');

        const productUrlEl = firstCell.querySelector('a') as HTMLAnchorElement;
        const productUrl = productUrlEl ? productUrlEl.href : window.location.href;

        if (pip) {
            results.push({
              source: 'alliance',
              title: title || 'Unknown',
              price,
              inStock,
              url: productUrl,
              pip
            });
        }
      }

      // Filter uniques
      return results.filter((value, index, self) =>
        index === self.findIndex((t) => (t.pip === value.pip && t.title === value.title))
      );
    });
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}

export const allianceScraper = new AllianceScraper();
