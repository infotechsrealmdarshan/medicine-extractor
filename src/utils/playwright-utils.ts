import { Page } from 'playwright';

/**
 * Blocks images, fonts, and stylesheets to speed up scraping.
 */
export async function blockDumbResources(page: Page) {
  await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf,otf,css,less,scss}', (route) => route.abort());
}
