// atlas-recon-v3.js
// WHAT CHANGED FROM v2:
//   - Correct URL pattern confirmed: /ATL (no /airport/ prefix)
//   - Waits for full JS hydration (up to 15s) not just networkidle
//   - Intercepts RSC text/x-component streams (App Router data delivery)
//   - Captures ALL fetch/XHR calls including post-hydration ones
//   - Reads fully rendered DOM text after React mounts
//   - Logs JS bundle contents snippet to find API endpoint strings

const { chromium } = require('playwright');

const TEST_AIRPORT = 'ATL';
const TARGET_URL = `https://atlas-navigation.com/${TEST_AIRPORT}`;

(async () => {
  console.log(`\nATLAS RECON v3 — Deep hydration probe for ${TEST_AIRPORT}`);
  console.log('='.repeat(60));

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();

  // Track every single request and response
  const allRequests = [];
  const allResponses = [];

  page.on('request', req => {
    allRequests.push({ url: req.url(), method: req.method() });
  });

  page.on('response', async (response) => {
    const url = response.url();
    const ct = response.headers()['content-type'] || '';
    const status = response.status();

    // Skip static assets
    if (url.includes('.png') || url.includes('.ico') || url.includes('.woff')) return;

    try {
      // Capture RSC streams (text/x-component is App Router RSC payload)
      if (ct.includes('text/x-component') || ct.includes('text/plain')) {
        const text = await response.text().catch(() => '');
        if (text.length > 10) {
          allResponses.push({ type: 'RSC', url, ct, body: text.slice(0, 3000) });
        }
      }
      // Capture JSON
      else if (ct.includes('application/json')) {
        const body = await response.json().catch(() => null);
        if (body) {
          allResponses.push({ type: 'JSON', url, ct, body: JSON.stringify(body, null, 2).slice(0, 3000) });
        }
      }
      // Capture _next/data routes (pages router data)
      else if (url.includes('/_next/data/')) {
        const text = await response.text().catch(() => '');
        allResponses.push({ type: 'NEXT_DATA_ROUTE', url, ct, body: text.slice(0, 3000) });
      }
    } catch (_) {}
  });

  // ── Navigate ────────────────────────────────────────────────────────
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // ── Strategy 1: Wait for a number to appear (wait time rendered) ────
  console.log('\n⏳ Waiting up to 12s for wait time data to render...');
  try {
    await page.waitForFunction(
      () => {
        const text = document.body.innerText;
        return /\d+\s*min/i.test(text) || text.includes('Standard') || text.includes('PreCheck') || text.includes('checkpoint');
      },
      { timeout: 12000 }
    );
    console.log('✅ Data appeared in DOM!');
  } catch (_) {
    console.log('⚠️  Timed out waiting for data — dumping what we have anyway');
  }

  // Extra settle time for any post-render fetches
  await page.waitForTimeout(3000);

  // ── Read fully rendered DOM ──────────────────────────────────────────
  const renderedText = await page.evaluate(() => document.body.innerText);
  console.log('\n📄 FULLY RENDERED PAGE TEXT (first 2000 chars):');
  console.log(renderedText.slice(0, 2000));

  // ── All non-Google/non-static requests ──────────────────────────────
  console.log('\n🌐 ALL REQUESTS (post-hydration included):');
  allRequests
    .filter(r =>
      !r.url.includes('google') &&
      !r.url.includes('doubleclick') &&
      !r.url.includes('gtag') &&
      !r.url.includes('.png') &&
      !r.url.includes('.woff') &&
      !r.url.includes('.ico') &&
      !r.url.includes('.css')
    )
    .forEach(r => console.log(`  [${r.method}] ${r.url}`));

  // ── Captured API/RSC responses ───────────────────────────────────────
  if (allResponses.length) {
    console.log(`\n📡 CAPTURED RESPONSES (${allResponses.length} total):`);
    allResponses.forEach((r, i) => {
      console.log(`\n--- [${i + 1}] TYPE: ${r.type} ---`);
      console.log(`URL: ${r.url}`);
      console.log(`Content-Type: ${r.ct}`);
      console.log(`Body:\n${r.body}`);
    });
  } else {
    console.log('\n📡 No API/RSC responses captured');
  }

  // ── Scan JS bundles for API endpoint strings ─────────────────────────
  console.log('\n🔍 Scanning JS bundles for API/fetch/supabase strings...');
  const jsBundles = allRequests
    .filter(r => r.url.includes('atlas-navigation.com/_next/static/chunks') && r.url.endsWith('.js'))
    .slice(0, 5); // only first 5 to keep runtime short

  for (const bundle of jsBundles) {
    try {
      const resp = await page.evaluate(async (url) => {
        const r = await fetch(url);
        return r.text();
      }, bundle.url);

      // Look for anything that looks like an API route or database call
      const hits = [];
      const patterns = [
        /["'`](\/api\/[^"'`\s]{3,50})["'`]/g,
        /["'`](https?:\/\/[^"'`\s]{10,80})["'`]/g,
        /supabase/gi,
        /fetch\([^)]{5,80}\)/g,
        /axios\.[a-z]+\([^)]{5,80}\)/g,
        /endpoint['":\s]+["'`][^"'`]{5,60}["'`]/gi,
        /baseUrl['":\s]+["'`][^"'`]{5,60}["'`]/gi,
      ];

      for (const pattern of patterns) {
        let m;
        const re = new RegExp(pattern.source, pattern.flags);
        while ((m = re.exec(resp)) !== null) {
          hits.push(m[0].slice(0, 120));
          if (hits.length > 30) break;
        }
      }

      if (hits.length) {
        console.log(`\n  Bundle: ${bundle.url.split('/').pop()}`);
        hits.forEach(h => console.log(`    → ${h}`));
      }
    } catch (_) {}
  }

  // ── Full HTML (first 3000 chars post-hydration) ──────────────────────
  const html = await page.content();
  console.log('\n📋 POST-HYDRATION HTML (first 3000 chars):');
  console.log(html.slice(0, 3000));

  await browser.close();
  console.log('\n\nRECON v3 COMPLETE');
})();
