import { sigConnectScraper } from './src/scrapers/sigconnect.scraper';
import logger from './src/utils/logger';

async function testSigConnect() {
  try {
    const products = await sigConnectScraper.scrape('1250323');
    console.log('Found products:', JSON.stringify(products, null, 2));
  } catch (error) {
    console.error('Test failed:', error);
  } finally {
    await sigConnectScraper.close();
  }
}

testSigConnect();
