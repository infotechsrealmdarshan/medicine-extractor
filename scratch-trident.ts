import { tridentScraper } from './src/scrapers/trident.scraper';
import logger from './src/utils/logger';

async function testTrident() {
  try {
    const products = await tridentScraper.scrape('08306375');
    console.log('Found products:', JSON.stringify(products, null, 2));
  } catch (error) {
    console.error('Test failed:', error);
  } finally {
    await tridentScraper.close();
  }
}

testTrident();
