// atlas-recon.js
// PURPOSE: Intercept all network calls on Atlas airport pages and log
//          every API endpoint + full JSON response. Run this ONCE to
//          map the data shape before building the real scraper.

const { chromium } = require('playwright');

const AIRPORTS = [
  'ATL', 'DFW', 'DEN', 'ORD', 'LAX',
  'CLT', 'MCO', 'LAS', 'PHX', 'SEA',
  'MSP', 'BUR'
];

async function reconAirport(browser, code) {
  const page = await browser.newPage();
  const captured = [];

  // Intercept every fetch/XHR response
  page.on('response', async (response) => {
    const url = response.url();
    const status = response.status();

    // Only care about JSON responses from atlas-navigation.com
    if (
      url.includes('atlas-navigation.com') &&
      !url.includes('/_next/') &&
      !url.includes('.png') &&
      !url.includes('.ico') &&
      !url.includes('.css') &&
      !url.includes('.js')
    ) {
      try {
        const contentType = response.headers()['content-type'] || '';
        if (contentType.includes('application/json') || contentType.includes('text/plain')) {
          const body = await response.json().catch(() => null);
          if (body) {
            captured.push({
              url,
              status,
              body: JSON.stringify(body, null, 2).slice(0, 3000) // cap at 3k chars
            });
          }
        }
      } catch (e) {
        // skip non-parseable
      }
    }
  });

  try {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`RECON: ${code}`);
    console.log('='.repeat(60));

    await page.goto(`https://atlas-navigation.com/airport/${code}`, {
      waitUntil: 'networkidle',
      timeout: 30000
    });

    // Extra wait to catch any lazy-loaded data fetches
    await page.waitForTimeout(4000);

    if (captured.length === 0) {
      console.log(`[${code}] No JSON API calls intercepted.`);

      // Fallback: dump all network calls made (even non-JSON) so we can investigate
      console.log(`[${code}] Trying full network log...`);
      const allRequests = [];
      page.on('request', (req) => allRequests.push(req.url()));
      await page.reload({ waitUntil: 'networkidle', timeout: 20000 });
      await page.waitForTimeout(2000);
      console.log(`[${code}] All requests made:`);
      allRequests
        .filter(u => !u.includes('/_next/static') && !u.includes('.png'))
        .forEach(u => console.log('  REQ:', u));
    } else {
      captured.forEach((entry, i) => {
        console.log(`\n--- CALL ${i + 1} ---`);
        console.log(`URL: ${entry.url}`);
        console.log(`Status: ${entry.status}`);
        console.log(`Body:\n${entry.body}`);
      });
    }

  } catch (err) {
    console.log(`[${code}] ERROR: ${err.message}`);
  } finally {
    await page.close();
  }
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  for (const code of AIRPORTS) {
    await reconAirport(browser, code);
    await new Promise(r => setTimeout(r, 1500)); // polite delay between airports
  }

  await browser.close();
  console.log('\n\nRECON COMPLETE');
})();
