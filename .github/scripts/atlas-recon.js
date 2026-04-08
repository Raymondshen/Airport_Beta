// atlas-recon-v5.js
// STRATEGY: Use page.route() to intercept JS bundles BEFORE navigation starts.
// Also directly fetch bundle URLs we already know from previous runs.

const { chromium } = require('playwright');

const BASE = 'https://atlas-navigation.com';

// We already know these bundle filenames from v2/v3 output — fetch them directly
const KNOWN_BUNDLES = [
  '01f1485904d0eaa2.js',
  '236f7e5abd6f09ff.js',
  '930e6194b8655375.js',
  '249261e921aeebba.js',
  '19e831b7929c9b12.js',
  '28969971b9d960c8.js',
  'ff1a16fafef87110.js',
  '7340adf74ff47ec0.js',
];

const DPL = 'dpl_BFTjrdL631G5JfuKaq6LzLgmkLU9';

async function fetchAndScan(page, filename) {
  const url = `${BASE}/_next/static/chunks/${filename}?dpl=${DPL}`;
  console.log(`\n📦 Scanning: ${filename}`);

  let src = '';
  try {
    // Use Node's built-in fetch (Node 18+)
    const resp = await fetch(url);
    src = await resp.text();
  } catch (e) {
    // Fallback: use page context
    try {
      src = await page.evaluate(async (u) => {
        const r = await fetch(u);
        return r.text();
      }, url);
    } catch (e2) {
      console.log(`  ❌ Failed: ${e2.message}`);
      return;
    }
  }

  if (!src || src.length < 100) {
    console.log(`  ⚠️  Empty or tiny response (${src.length} chars)`);
    return;
  }

  console.log(`  Size: ${src.length} chars`);

  // ── Targeted extractions ──────────────────────────────────────────
  const results = {
    apiRoutes:    [...new Set((src.match(/["'`](\/api\/[^"'`\s]{2,80})["'`]/g) || []))],
    fetchCalls:   [...new Set((src.match(/fetch\(["'`][^"'`]{5,120}["'`]/g) || []))],
    externalUrls: [...new Set((src.match(/https?:\/\/[a-zA-Z0-9._-]{4,60}[^\s"'`<>]{0,60}/g) || [])
                    .filter(u => !u.includes('google') && !u.includes('gtag') && !u.includes('doubleclick')))],
    supabase:     src.match(/.{0,60}supabase.{0,80}/gi) || [],
    airportATL:   (src.match(/.{0,40}ATL.{0,60}/g) || []).slice(0, 5),
    routeStrings: [...new Set((src.match(/["'`]\/[a-z][a-z0-9/-]{2,40}["'`]/g) || [])
                    .filter(s => !s.includes('next') && !s.includes('static') && !s.includes('.js')))].slice(0, 20),
  };

  let hasHits = false;
  for (const [key, vals] of Object.entries(results)) {
    if (vals.length > 0) {
      hasHits = true;
      console.log(`  ✅ ${key} (${vals.length}):`);
      vals.slice(0, 10).forEach(v => console.log(`      ${v}`));
    }
  }

  if (!hasHits) {
    // Dump first 800 chars so we can see what's in it
    console.log('  No structured hits. Raw snippet:');
    console.log('  ' + src.slice(0, 800).replace(/\n/g, ' '));
  }
}

(async () => {
  console.log('\nATLAS RECON v5 — Direct bundle fetch + scan');
  console.log('='.repeat(60));

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();

  // ── Phase 1: Scan all known bundles directly ─────────────────────
  console.log('\n[PHASE 1] Scanning known bundles from previous recon...');
  for (const filename of KNOWN_BUNDLES) {
    await fetchAndScan(page, filename);
  }

  // ── Phase 2: Navigate to homepage, intercept ANY new bundle names ─
  console.log('\n\n[PHASE 2] Navigate to homepage and intercept bundle list...');
  const interceptedBundles = new Set();

  await page.route('**/_next/static/chunks/*.js*', async route => {
    const url = route.request().url();
    const name = url.split('/').pop().split('?')[0];
    if (!KNOWN_BUNDLES.includes(name)) {
      interceptedBundles.add(name);
    }
    await route.continue();
  });

  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);

  console.log(`  Intercepted ${interceptedBundles.size} new bundles on homepage`);
  for (const name of interceptedBundles) {
    await fetchAndScan(page, name);
  }

  // ── Phase 3: Navigate to /ATL, intercept any NEW bundles ─────────
  console.log('\n\n[PHASE 3] Navigate to /ATL, look for page-specific bundles...');
  const airportBundles = new Set();

  await page.route('**/_next/static/chunks/*.js*', async route => {
    const url = route.request().url();
    const name = url.split('/').pop().split('?')[0];
    if (!KNOWN_BUNDLES.includes(name) && !interceptedBundles.has(name)) {
      airportBundles.add(name);
    }
    await route.continue();
  });

  await page.goto(`${BASE}/ATL`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);

  console.log(`  Intercepted ${airportBundles.size} airport-specific bundles`);
  for (const name of airportBundles) {
    await fetchAndScan(page, name);
  }

  // ── Phase 4: Read the fully rendered DOM ─────────────────────────
  console.log('\n\n[PHASE 4] Rendered DOM on /ATL:');
  const text = await page.evaluate(() => document.body.innerText);
  console.log(text.slice(0, 1500));

  await browser.close();
  console.log('\n\nRECON v5 COMPLETE');
})();
