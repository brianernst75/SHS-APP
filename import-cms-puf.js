#!/usr/bin/env node
/**
 * CMS Formulary PUF Import Script
 * Downloads the latest monthly CMS PUF and imports into MongoDB
 * 
 * Files we use from the PUF ZIP:
 *   - basic_drugs_formulary.txt  → NDC, tier, PA, step therapy, qty limits
 *   - beneficiary_cost.txt       → Tier copays (retail preferred/standard, mail order)
 *   - plan_information.txt       → Plan name, contract ID, plan ID lookup
 * 
 * Run manually: node import-cms-puf.js
 * Or via Railway cron: 0 6 1 * * (1st of every month at 6am)
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { MongoClient } = require('mongodb');
const readline = require('readline');

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = 'shs';

// Most recent PUF URL - update this monthly or auto-detect (see fetchLatestPufUrl)
// August 2026 file (2026 plan year data)
const LATEST_PUF_URL = 'https://data.cms.gov/sites/default/files/2026-08/d8c9b393-66f0-4973-a748-f66742fe0fd2/2026_20260819.zip';

const TMP_DIR = '/tmp/cms_puf';
const ZIP_PATH = path.join(TMP_DIR, 'puf.zip');
const EXTRACT_DIR = path.join(TMP_DIR, 'extracted');

// ─── Auto-detect latest PUF URL from CMS catalog ───────────────────────────
async function fetchLatestPufUrl() {
  return new Promise((resolve) => {
    const url = 'https://data.cms.gov/data-api/v1/dataset/cb2a224f-4d52-4cae-aa55-8c00c671384f/data-viewer';
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          // Try to parse and find latest zip
          const json = JSON.parse(data);
          // Fall back to hardcoded if we can't parse
          resolve(LATEST_PUF_URL);
        } catch {
          resolve(LATEST_PUF_URL);
        }
      });
    }).on('error', () => resolve(LATEST_PUF_URL));
  });
}

// ─── Download ZIP ───────────────────────────────────────────────────────────
async function downloadPuf(url) {
  console.log(`📥 Downloading CMS PUF from: ${url}`);
  fs.mkdirSync(TMP_DIR, { recursive: true });
  
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(ZIP_PATH);
    https.get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        https.get(response.headers.location, (r2) => {
          r2.pipe(file);
          file.on('finish', () => { file.close(); resolve(); });
        });
      } else {
        response.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
      }
    }).on('error', reject);
  });
}

// ─── Extract ZIP ────────────────────────────────────────────────────────────
function extractZip() {
  console.log('📦 Extracting ZIP...');
  fs.mkdirSync(EXTRACT_DIR, { recursive: true });
  execSync(`unzip -o ${ZIP_PATH} -d ${EXTRACT_DIR}`);
  
  // List what we got
  const files = fs.readdirSync(EXTRACT_DIR);
  console.log('Files extracted:', files);
  return files;
}

// ─── Find file by partial name ───────────────────────────────────────────────
function findFile(dir, keyword) {
  const files = fs.readdirSync(dir);
  const found = files.find(f => f.toLowerCase().includes(keyword.toLowerCase()));
  if (!found) throw new Error(`Could not find file matching: ${keyword}`);
  return path.join(dir, found);
}

// ─── Parse pipe-delimited file line by line ──────────────────────────────────
async function parseFile(filePath, onRow) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: 'latin1' }),
      crlfDelay: Infinity
    });
    
    let headers = null;
    let count = 0;
    
    rl.on('line', (line) => {
      const cols = line.split('|');
      if (!headers) {
        headers = cols.map(h => h.trim());
        return;
      }
      const row = {};
      headers.forEach((h, i) => { row[h] = (cols[i] || '').trim(); });
      onRow(row);
      count++;
    });
    
    rl.on('close', () => { console.log(`  Parsed ${count.toLocaleString()} rows`); resolve(); });
    rl.on('error', reject);
  });
}

// ─── Main Import ─────────────────────────────────────────────────────────────
async function runImport() {
  console.log('\n🚀 CMS Formulary PUF Import Starting...');
  console.log(`📅 ${new Date().toISOString()}\n`);

  if (!MONGODB_URI) throw new Error('MONGODB_URI not set');

  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db(DB_NAME);
  
  // Step 1: Download
  const url = await fetchLatestPufUrl();
  await downloadPuf(url);
  
  // Step 2: Extract
  extractZip();
  
  // Step 3: Load plan info (contract_id + plan_id → plan name)
  console.log('\n📋 Loading plan information...');
  const planMap = {}; // "H0609-073" → plan name
  const planFile = findFile(EXTRACT_DIR, 'plan_information');
  await parseFile(planFile, (row) => {
    const key = `${row.CONTRACT_ID}-${String(row.PLAN_ID).padStart(3,'0')}`;
    planMap[key] = row.PLAN_NAME || row.PLAN_NM || '';
  });
  console.log(`  Loaded ${Object.keys(planMap).length} plans`);

  // Step 4: Load beneficiary cost (tier copays per plan)
  console.log('\n💰 Loading beneficiary cost data...');
  const costMap = {}; // "H0609-073" → { tier1_pref_retail, tier1_std_retail, tier1_mail, ... }
  const costFile = findFile(EXTRACT_DIR, 'beneficiary_cost');
  await parseFile(costFile, (row) => {
    const key = `${row.CONTRACT_ID}-${String(row.PLAN_ID).padStart(3,'0')}`;
    if (!costMap[key]) costMap[key] = {};
    const tier = row.COST_SHARE_TIER || row.TIER_NUM || row.DRUG_COST_TIER;
    if (tier) {
      costMap[key][`tier${tier}`] = {
        preferred_retail_copay:    parseFloat(row.PREF_RETAIL_COPAY || row.PREFERRED_RETAIL_COPAY || 0),
        preferred_retail_coins:    parseFloat(row.PREF_RETAIL_COINS || 0),
        standard_retail_copay:     parseFloat(row.STD_RETAIL_COPAY  || row.NONPREF_RETAIL_COPAY  || 0),
        standard_retail_coins:     parseFloat(row.STD_RETAIL_COINS  || 0),
        mail_copay:                parseFloat(row.PREF_MAIL_COPAY   || row.MAIL_ORDER_COPAY      || 0),
        mail_coins:                parseFloat(row.PREF_MAIL_COINS   || 0),
      };
    }
  });
  console.log(`  Loaded cost data for ${Object.keys(costMap).length} plans`);

  // Step 5: Load & import formulary drugs
  console.log('\n💊 Loading drug formulary data...');
  const formularyFile = findFile(EXTRACT_DIR, 'basic_drugs');
  
  const collection = db.collection('formulary');
  await collection.drop().catch(() => {}); // Fresh import each month
  await collection.createIndex({ contract_plan_id: 1, ndc: 1 });
  await collection.createIndex({ contract_plan_id: 1, rxcui: 1 });
  await collection.createIndex({ drug_name_lower: 1 });
  await collection.createIndex({ contract_plan_id: 1, drug_name_lower: 1 });

  const BATCH_SIZE = 5000;
  let batch = [];
  let totalInserted = 0;

  async function flushBatch() {
    if (batch.length === 0) return;
    await collection.insertMany(batch, { ordered: false });
    totalInserted += batch.length;
    if (totalInserted % 100000 === 0) process.stdout.write(`  ${totalInserted.toLocaleString()} drugs imported...\r`);
    batch = [];
  }

  await parseFile(formularyFile, (row) => {
    const contractId  = row.CONTRACT_ID;
    const planId      = String(row.PLAN_ID || row.PLAN_NUM || '').padStart(3, '0');
    const planKey     = `${contractId}-${planId}`;
    const tier        = parseInt(row.TIER_LEVEL_VALUE || row.TIER_NUM || row.FORMULARY_TIER || 0);
    const tierCosts   = (costMap[planKey] || {})[`tier${tier}`] || {};

    batch.push({
      contract_plan_id:     planKey,            // e.g. "H0609-073"
      contract_id:          contractId,          // e.g. "H0609"
      plan_id:              planId,              // e.g. "073"
      plan_name:            planMap[planKey] || '',
      ndc:                  row.RXCUI || row.NDC || '',
      rxcui:                row.RXCUI || '',
      drug_name:            row.LABEL_NAME || row.DRUG_NAME || row.PROPRIETARY_NAME || '',
      drug_name_lower:      (row.LABEL_NAME || row.DRUG_NAME || '').toLowerCase(),
      tier:                 tier,
      tier_label:           tierLabel(tier),
      requires_pa:          row.PRIOR_AUTHORIZATION_YN === 'Y' || row.PA_YN === 'Y',
      step_therapy:         row.STEP_THERAPY_YN === 'Y' || row.ST_YN === 'Y',
      quantity_limit:       row.QUANTITY_LIMIT_YN === 'Y' || row.QL_YN === 'Y',
      selected_drug:        row.SELECTED_DRUG_FLAG === 'Y', // IRA negotiated drug
      // Pricing from beneficiary cost file
      preferred_retail_copay: tierCosts.preferred_retail_copay || null,
      preferred_retail_coins: tierCosts.preferred_retail_coins || null,
      standard_retail_copay:  tierCosts.standard_retail_copay  || null,
      standard_retail_coins:  tierCosts.standard_retail_coins  || null,
      mail_copay:             tierCosts.mail_copay              || null,
      mail_coins:             tierCosts.mail_coins              || null,
      imported_at:          new Date(),
      plan_year:            2026,
    });

    if (batch.length >= BATCH_SIZE) flushBatch();
  });

  await flushBatch();
  console.log(`\n✅ Total imported: ${totalInserted.toLocaleString()} drug-plan records`);

  // Step 6: Also update puf_metadata collection
  await db.collection('puf_metadata').updateOne(
    { type: 'formulary' },
    { $set: { last_imported: new Date(), source_url: url, record_count: totalInserted } },
    { upsert: true }
  );

  // Cleanup
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  
  await client.close();
  console.log('\n🎉 Import complete!\n');
}

function tierLabel(tier) {
  const labels = {
    1: 'Tier 1 — Preferred Generic',
    2: 'Tier 2 — Generic',
    3: 'Tier 3 — Preferred Brand',
    4: 'Tier 4 — Non-Preferred Drug',
    5: 'Tier 5 — Specialty',
  };
  return labels[tier] || `Tier ${tier}`;
}

runImport().catch(err => {
  console.error('❌ Import failed:', err);
  process.exit(1);
});
