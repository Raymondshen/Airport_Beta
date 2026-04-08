// atlas-recon-v6.js
// STRATEGY: We found the money bundle: 773f52769d21364c.js
// Read it fully and extract:
//   - exact fetch() call shapes for /api/crowdsource, /api/flight, /api/historicalData
//   - request params, headers, auth tokens
//   - how airport codes map to checkpoint IDs
//   - the full `eh` checkpoint ID object for all airports
//   - Supabase usage pattern

const BASE = 'https://atlas-navigation.com';
const DPL  = 'dpl_BFTjrdL631G5JfuKaq6LzLgmkLU9';

// The money bundle
const TARGET_BUNDLE = '773f52769d21364c.js';

// Also scan the Supabase bundle for the anon key
const SUPABASE_BUNDLE = '28969971b9d960c8.js';

async function fetchBundle(filename) {
  const url = `${BASE}/_next/static/chunks/${filename}?dpl=${DPL}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.text();
}

function extractContext(src, keyword, contextChars = 300) {
  const results = [];
  let idx = 0;
  while (true) {
    const pos = src.indexOf(keyword, idx);
    if (pos === -1) break;
    const start = Math.max(0, pos - contextChars);
    const end   = Math.min(src.length, pos + contextChars);
    results.push(src.slice(start, end));
    idx = pos + keyword.length;
    if (results.length >= 8) break;
  }
  return results;
}

(async () => {
  console.log('\nATLAS RECON v6 — Full bundle dissection');
  console.log('='.repeat(60));

  // ── 1. Read the money bundle ────────────────────────────────────
  console.log(`\n[1] Reading ${TARGET_BUNDLE}...`);
  const src = await fetchBundle(TARGET_BUNDLE);
  console.log(`  Size: ${src.length} chars`);

  // ── 2. Extract all API endpoint contexts ───────────────────────
  const endpoints = ['/api/crowdsource', '/api/flight', '/api/historicalData', '/api/broadcast'];
  for (const ep of endpoints) {
    const hits = extractContext(src, ep, 400);
    if (hits.length) {
      console.log(`\n${'─'.repeat(60)}`);
      console.log(`API: ${ep}  (${hits.length} occurrences)`);
      hits.forEach((h, i) => {
        console.log(`\n  --- occurrence ${i + 1} ---`);
        console.log(h);
      });
    }
  }

  // ── 3. Extract fetch() calls ────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`);
  console.log('\n[2] All fetch() calls:');
  const fetchMatches = src.match(/fetch\([^)]{0,200}\)/g) || [];
  fetchMatches.forEach(m => console.log(' ', m));

  // ── 4. Extract the full `eh` checkpoint ID map ──────────────────
  console.log(`\n${'─'.repeat(60)}`);
  console.log('\n[3] Full checkpoint ID map (eh object):');
  const ehCtx = extractContext(src, 'eh={', 2000);
  ehCtx.forEach(h => console.log(h));

  // Also try em (airport names map)
  const emCtx = extractContext(src, 'em={', 2000);
  if (emCtx.length) {
    console.log('\n[4] Full airport names map (em object):');
    emCtx.forEach(h => console.log(h));
  }

  // ── 5. Extract Supabase session/auth usage ──────────────────────
  console.log(`\n${'─'.repeat(60)}`);
  console.log('\n[5] Supabase auth context in money bundle:');
  const sbHits = extractContext(src, 'supabase', 200);
  sbHits.forEach((h, i) => console.log(`\n  [${i+1}] ${h}`));

  // ── 6. Look for Bearer / Authorization headers ──────────────────
  console.log(`\n${'─'.repeat(60)}`);
  console.log('\n[6] Auth header references:');
  const authHits = extractContext(src, 'Authorization', 200);
  const bearerHits = extractContext(src, 'Bearer', 200);
  const anonHits = extractContext(src, 'anon', 150);
  [...authHits, ...bearerHits, ...anonHits].forEach((h, i) => console.log(`\n  [${i+1}] ${h}`));

  // ── 7. Read Supabase bundle for anon key ────────────────────────
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`\n[7] Reading Supabase bundle for anon key: ${SUPABASE_BUNDLE}`);
  const sbSrc = await fetchBundle(SUPABASE_BUNDLE);
  console.log(`  Size: ${sbSrc.length} chars`);

  // Anon key is a long JWT starting with "eyJ"
  const anonKeys = sbSrc.match(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g) || [];
  console.log(`  JWT tokens found: ${anonKeys.length}`);
  anonKeys.forEach((k, i) => console.log(`  [${i+1}] ${k.slice(0, 80)}...`));

  // Also extract the supabase URL confirmation
  const sbUrlHits = sbSrc.match(/https:\/\/[a-z0-9]+\.supabase\.co/g) || [];
  console.log(`  Supabase URLs: ${[...new Set(sbUrlHits)].join(', ')}`);

  // Supabase anon key context
  const sbAnonCtx = extractContext(sbSrc, 'qkfbntsrlkplvrmhjgqw', 300);
  sbAnonCtx.forEach((h, i) => console.log(`\n  [${i+1}] ${h}`));

  console.log('\n\nRECON v6 COMPLETE');
})();
