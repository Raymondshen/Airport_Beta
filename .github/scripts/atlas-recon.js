// atlas-recon-v2.js
// WHAT CHANGED FROM v1:
//   - Tries 6 different URL patterns per airport to find the correct one
//   - Extracts __NEXT_DATA__ from the HTML (SSR-embedded JSON — the real prize)
//   - Dumps full page HTML title and any visible wait time text found on page
//   - Logs ALL network requests including _next/data RSC routes
//   - Checks for Supabase, Firebase, or other backend calls

const { chromium } = require('playwright');

// Only test ONE airport — we just need to find the working URL pattern
// Once confirmed, the real scraper handles all 12
const TEST_AIRPORT = 'ATL';

// All plausible URL patterns for a Next.js TSA wait time app
const URL_PATTERNS = [
  `https://atlas-navigation.com/${TEST_AIRPORT}`,
  `https://atlas-navigation.com/${TEST_AIRPORT.toLowerCase()}`,
  `https://atlas-navigation.com/airports/${TEST_AIRPORT}`,
  `https://atlas-navigation.com/airports/${TEST_AIRPORT.toLowerCase()}`,
  `https://atlas-navigation.com/airport/${TEST_AIRPORT.toLowerCase()}`,
  `https://atlas-navigation.com/times/${TEST_AIRPORT}`,
  `https://atlas-navigation.com/tsa/${TEST_AIRPORT}`,
  `https://atlas-navigation.com/wait/${TEST_AIRPORT}`,
];

async function probeUrl(browser, url) {
  const page = await browser.newPage();
  const allRequests = [];
  const jsonResponses = [];

  // Capture ALL requests (including _next/data routes which carry SSR JSON)
  page.on('request', req => allRequests.push(req.url()));

  // Capture ALL JSON responses from any domain
  page.on('response', async (response) => {
    const url = response.url();
    const ct = response.headers()['content-type'] || '';
    if (ct.includes('json')) {
      try {
        const body = await response.json().catch(() => null);
        if (body) jsonResponses.push({ url, body: JSON.stringify(body, null, 2).slice(0, 2000) });
      } catch (_) {}
    }
  });

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 25000 });
    await page.waitForTimeout(3000);

    const title = await page.title();
    const is404 = title.includes('404') || title.includes('not found');

    if (is404) {
      console.log(`  ❌ 404 — ${url}`);
      await page.close();
      return false;
    }

    console.log(`\n${'★'.repeat(60)}`);
    console.log(`✅ VALID PAGE FOUND: ${url}`);
    console.log(`   Title: "${title}"`);
    console.log('★'.repeat(60));

    // ── 1. Extract __NEXT_DATA__ (SSR-embedded JSON) ──────────────────
    const nextData = await page.evaluate(() => {
      const el = document.getElementById('__NEXT_DATA__');
      return el ? el.textContent : null;
    });

    if (nextData) {
      console.log('\n📦 __NEXT_DATA__ FOUND (SSR JSON):');
      // Pretty print but cap at 5000 chars
      try {
        const parsed = JSON.parse(nextData);
        console.log(JSON.stringify(parsed, null, 2).slice(0, 5000));
      } catch (_) {
        console.log(nextData.slice(0, 5000));
      }
    } else {
      console.log('\n⚠️  No __NEXT_DATA__ found (may be App Router / RSC)');
    }

    // ── 2. Look for wait time numbers visible on the page ─────────────
    const bodyText = await page.evaluate(() => document.body.innerText);
    const waitMatches = bodyText.match(/\d+\s*(min|minute|minutes)/gi) || [];
    console.log('\n⏱️  Wait time text found on page:');
    if (waitMatches.length) {
      console.log(waitMatches.slice(0, 20).join(', '));
    } else {
      console.log('  None found');
    }

    // ── 3. All network requests ───────────────────────────────────────
    console.log('\n🌐 All network requests made:');
    allRequests
      .filter(u =>
        !u.includes('google') &&
        !u.includes('doubleclick') &&
        !u.includes('gtag') &&
        !u.includes('.png') &&
        !u.includes('.woff') &&
        !u.includes('.ico')
      )
      .forEach(u => console.log('  →', u));

    // ── 4. Any JSON API calls ─────────────────────────────────────────
    if (jsonResponses.length) {
      console.log('\n📡 JSON API RESPONSES:');
      jsonResponses.forEach((r, i) => {
        console.log(`\n  [${i + 1}] ${r.url}`);
        console.log(r.body);
      });
    } else {
      console.log('\n📡 No JSON API calls intercepted');
    }

    // ── 5. Page HTML snapshot (first 3000 chars) ──────────────────────
    const html = await page.content();
    console.log('\n📄 HTML snapshot (first 3000 chars):');
    console.log(html.slice(0, 3000));

    await page.close();
    return true;

  } catch (err) {
    console.log(`  💥 ERROR on ${url}: ${err.message}`);
    await page.close();
    return false;
  }
}

(async () => {
  console.log(`\nATLAS RECON v2 — Finding correct URL pattern for ${TEST_AIRPORT}`);
  console.log('='.repeat(60));

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  for (const pattern of URL_PATTERNS) {
    const found = await probeUrl(browser, pattern);
    if (found) {
      console.log(`\n\n🎯 CORRECT PATTERN: ${pattern}`);
      console.log('Stop here — use this pattern for all 12 airports.');
      break;
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  await browser.close();
  console.log('\n\nRECON v2 COMPLETE');
})();
