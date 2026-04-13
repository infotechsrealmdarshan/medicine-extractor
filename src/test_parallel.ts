import { searchService } from './services/search.service';

async function test() {
  console.log('Starting parallel test search for PIP: 06028575...');
  try {
    const results = await searchService.search('06028575');
    console.log('--- SEARCH RESULTS ---');
    console.log(JSON.stringify(results, null, 2));
  } catch (error) {
    console.error('Test failed:', error);
  }
  process.exit(0);
}

test();
