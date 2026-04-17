import { aahScraper } from './src/scrapers/aah.scraper';
import logger from './src/utils/logger';
import fs from 'fs';
import path from 'path';

async function testAAH() {
  const query = 'CIP0153D';
  try {
    const products = await aahScraper.scrape(query);
    console.log('Found products:', JSON.stringify(products, null, 2));
    
    // If price is 0, let's try to see why by dumping page content
    if (products.length > 0 && products[0].price === 0) {
       console.log('Price is 0, investigated further...');
    }
  } catch (error) {
    console.error('Test failed:', error);
  } finally {
    await aahScraper.close();
  }
}

testAAH();
