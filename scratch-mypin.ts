import { myPinScraper } from './src/scrapers/mypin.scraper';

async function test() {
  console.log("Testing MyPin...");
  const res = await myPinScraper.scrape('6772362');
  console.log(JSON.stringify(res, null, 2));
  process.exit();
}

test();
