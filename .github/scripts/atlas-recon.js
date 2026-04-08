// atlas-recon-v4.js
// STRATEGY: Stop guessing URL patterns.
// Instead: fetch and read the compiled JS bundles to find:
//   - actual route definitions
//   - API endpoint strings
//   - any airport code references
//   - fetch/axios calls with real URLs

const { chromium } = require('playwright');

const BASE = 'https://atlas-navigation.com';

(async () => {
  console.log('\nATLAS RECON v4 — Reading JS bundles for routes + endpoints');
  console.log('='.repeat(60));

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();

  // Step 1: Load the homepage (always works) to get bundle URLs
  console.log('\n[1] Loading homepage to collect bundle URLs...');
  const bundleUrls = [];
  page.on('request', req => {
    const u = req.url();
    if (u.includes('/_next/static/chunks') && u.endsWith('.js')) {
      bundleUrls.push(u);
    }
  });

  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);
  console.log(`  Found ${bundleUrls.length} JS bundles`);

  // Step 2: Fetch and scan EVERY bundle for useful strings
  console.log('\n[2] Scanning all bundles...');

  const findings = {
    routes: [],
    apiEndpoints: [],
    fetchCalls: [],
    supabase: [],
    airportRefs: [],
    misc: []
  };

  for (const url of bundleUrls) {
    let src = '';
    try {
      const resp = await page.evaluate(async (u) => {
        const r = await fetch(u);
        return r.text();
      }, url);
      src = resp;
    } catch (e) {
      console.log(`  ⚠️  Could not fetch: ${url.split('/').pop()}`);
      continue;
    }

    const filename = url.split('/').pop().split('?')[0];
    const hits = [];

    // Route patterns
    const routeMatches = src.match(/["'`]\/[a-zA-Z][a-zA-Z0-9\-_/[\]]{2,60}["'`]/g) || [];
    routeMatches
      .filter(m => !m.includes('_next') && !m.includes('static') && !m.includes('.js') && !m.includes('.css'))
      .forEach(m => findings.routes.push({ file: filename, val: m }));

    // API endpoints
    const apiMatches = src.match(/["'`](\/api\/[^"'`\s]{2,60})["'`]/g) || [];
    apiMatches.forEach(m => findings.apiEndpoints.push({ file: filename, val: m }));

    // External fetch/axios calls
    const fetchMatches = src.match(/fetch\(["'`][^"'`]{8,100}["'`]/g) || [];
    fetchMatches.forEach(m => findings.fetchCalls.push({ file: filename, val: m }));

    // Supabase
    if (/supabase/i.test(src)) {
      const sbMatches = src.match(/.{0,40}supabase.{0,80}/gi) || [];
      sbMatches.forEach(m => findings.supabase.push({ file: filename, val: m }));
    }

    // Airport code references
    if (/\bATL\b/.test(src)) {
      const atlMatches = src.match(/.{0,30}\bATL\b.{0,60}/g) || [];
      atlMatches.slice(0, 5).forEach(m => findings.airportRefs.push({ file: filename, val: m }));
    }

    // URLs with domain
    const urlMatches = src.match(/https?:\/\/[a-zA-Z0-9][a-zA-Z0-9.\-_/?=&%]{10,100}/g) || [];
    urlMatches
      .filter(u => !u.includes('google') && !u.includes('gtag') && !u.includes('doubleclick') && !u.includes('atlas-navigation.com/og'))
      .forEach(m => findings.misc.push({ file: filename, val: m }));
  }

  // Step 3: Print findings
  console.log('\n' + '='.repeat(60));
  console.log('FINDINGS');
  console.log('='.repeat(60));

  console.log(`\n📍 ROUTES (${findings.routes.length} found — showing unique):`);
  [...new Set(findings.routes.map(f => f.val))].slice(0, 40).forEach(v => console.log('  ', v));

  console.log(`\n🔌 API ENDPOINTS (${findings.apiEndpoints.length} found):`);
  [...new Set(findings.apiEndpoints.map(f => f.val))].forEach(v => console.log('  ', v));

  console.log(`\n📡 FETCH CALLS (${findings.fetchCalls.length} found):`);
  [...new Set(findings.fetchCalls.map(f => f.val))].forEach(v => console.log('  ', v));

  console.log(`\n🗄️  SUPABASE REFERENCES (${findings.supabase.length} found):`);
  findings.supabase.forEach(f => console.log(`  [${f.file}]`, f.val));

  console.log(`\n✈️  AIRPORT CODE REFS (ATL mentions):`);
  findings.airportRefs.forEach(f => console.log(`  [${f.file}]`, f.val));

  console.log(`\n🌐 EXTERNAL URLS (${findings.misc.length} found — showing unique):`);
  [...new Set(findings.misc.map(f => f.val))].slice(0, 30).forEach(v => console.log('  ', v));

  // Step 4: Also try to find the page-level JS bundle specifically
  // The homepage loads layout chunks. The airport page loads a page-specific chunk.
  // Let's trigger it by navigating to the working URL.
  console.log('\n[3] Loading /ATL to capture page-specific bundles...');
  const airportBundles = [];
  page.on('request', req => {
    const u = req.url();
    if (u.includes('/_next/static/chunks') && u.endsWith('.js') && !bundleUrls.includes(u)) {
      airportBundles.push(u);
    }
  });

  await page.goto(`${BASE}/ATL`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);

  console.log(`  New bundles loaded by /ATL page: ${airportBundles.length}`);
  airportBundles.forEach(u => console.log('   ', u.split('/').pop().split('?')[0]));

  if (airportBundles.length > 0) {
    console.log('\n[4] Scanning airport-specific bundles...');
    for (const url of airportBundles) {
      const filename = url.split('/').pop().split('?')[0];
      try {
        const src = await page.evaluate(async (u) => {
          const r = await fetch(u);
          return r.text();
        }, url);

        console.log(`\n  📦 ${filename} (${src.length} chars)`);

        // Print first 2000 chars — page bundles are often small and revealing
        console.log('  CONTENT (first 2000 chars):');
        console.log(src.slice(0, 2000));

        // Targeted searches
        const apiHits = src.match(/["'`](\/api\/[^"'`\s]{2,80})["'`]/g) || [];
        const fetchHits = src.match(/fetch\([^)]{5,100}\)/g) || [];
        const urlHits = src.match(/https?:\/\/[^\s"'`]{10,100}/g) || [];

        if (apiHits.length) { console.log('\n  API routes:', apiHits); }
        if (fetchHits.length) { console.log('\n  Fetch calls:', fetchHits); }
        if (urlHits.length) { console.log('\n  URLs found:', urlHits.filter(u => !u.includes('google'))); }

      } catch (e) {
        console.log(`  ⚠️  Error reading ${filename}: ${e.message}`);
      }
    }
  }

  await browser.close();
  console.log('\n\nRECON v4 COMPLETE');
})();
