/**
 * Drug Search API Routes
 * Uses two collections:
 *   formulary_plans — maps contract_plan_id → formulary_id + tier_costs
 *   formulary       — drugs indexed by formulary_id
 */

const https = require('https');

function parsePlanKey(mapd) {
  if (!mapd || mapd === 'na' || mapd === 'n/a') return null;
  const parts = mapd.replace(/\s/g,'').split('-');
  if (parts.length >= 2) return `${parts[0]}-${parts[1].padStart(3,'0')}`;
  return null;
}

function getParams(req) {
  const url = new URL(req.url, 'http://localhost');
  return url.searchParams;
}

// ─── CMS Part D Drug Spending Lookup ─────────────────────────────────────────
// Returns average monthly drug cost from CMS Medicare Part D spending data
// Used to calculate estimated out-of-pocket for coinsurance tiers
const drugCostCache = {};

async function getCmsDrugCost(drugName) {
  // Extract generic name (remove brand/dosage info)
  const generic = drugName.replace(/\[.*?\]/g, '').replace(/\d+(\.\d+)?\s*(MG|ML|MCG|MG\/ML|%|IU)[^\s]*/gi, '').trim();
  const cacheKey = generic.toLowerCase().slice(0, 20);
  if (drugCostCache[cacheKey]) return drugCostCache[cacheKey];

  return new Promise(resolve => {
    // CMS Part D Spending dataset - public Socrata API, no key needed
    const encoded = encodeURIComponent(generic.slice(0, 30));
    const url = `https://data.cms.gov/data-api/v1/dataset/8c0571c3-3a2b-4535-9ff5-aec4b1ecfe5b/data?filter[Gnrc_Name]=${encoded}&size=1`;

    const req = https.get(url, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const rows = JSON.parse(data);
          if (rows && rows.length > 0) {
            // Tot_Spndng / Tot_Clms = avg cost per claim (30-day supply)
            const row = rows[0];
            const totalSpend  = parseFloat(row.Tot_Spndng || 0);
            const totalClaims = parseFloat(row.Tot_Clms   || 1);
            const avgPerClaim = totalSpend / totalClaims;
            const result = avgPerClaim > 0 ? Math.round(avgPerClaim) : null;
            drugCostCache[cacheKey] = result;
            resolve(result);
          } else {
            drugCostCache[cacheKey] = null;
            resolve(null);
          }
        } catch(e) {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(4000, () => { req.destroy(); resolve(null); });
  });
}

// Parse coinsurance % from string like "15%" → 0.15
function parseCoinsurance(costStr) {
  if (!costStr) return null;
  const match = costStr.match(/(\d+(\.\d+)?)\s*%/);
  return match ? parseFloat(match[1]) / 100 : null;
}

// Calculate estimated out of pocket given drug cost and copay string
// Returns formatted string like "~$45/mo" or null
function estimateOOP(avgDrugCost, copayStr) {
  if (!avgDrugCost || !copayStr) return null;
  const coins = parseCoinsurance(copayStr);
  if (!coins) return null;
  const estimated = Math.round(avgDrugCost * coins);
  return estimated > 0 ? `~$${estimated}/mo` : null;
}

// GET /api/drugs/cost?name=atorvastatin&plan=H0609-073-000
// Returns estimated out of pocket for a specific drug on a plan
async function drugCost(req, res, db) {
  try {
    const params    = getParams(req);
    const drugName  = (params.get('name') || '').trim();
    const planKey   = parsePlanKey(params.get('plan') || '');
    const tier      = parseInt(params.get('tier') || 0);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (!drugName || !planKey || !tier) return res.end(JSON.stringify({ estimated_oop: null }));

    // Get tier copay for this plan
    const maPlan = await db.collection('ma_plans').findOne({ planKey: planKey + '-000' });
    const tierData = (maPlan && maPlan.drugTiers || []).find(t => t.tier === tier);
    if (!tierData) return res.end(JSON.stringify({ estimated_oop: null }));

    const copayStr = tierData.retail30;
    const coins = parseCoinsurance(copayStr);
    if (!coins) return res.end(JSON.stringify({ estimated_oop: null, reason: 'flat_copay' }));

    // Look up average drug cost from CMS
    const avgCost = await getCmsDrugCost(drugName);
    if (!avgCost) return res.end(JSON.stringify({ estimated_oop: null, reason: 'no_cost_data' }));

    const oop = estimateOOP(avgCost, copayStr);
    res.end(JSON.stringify({
      estimated_oop: oop,
      avg_drug_cost: avgCost,
      coinsurance:   copayStr,
      disclaimer:    'Estimated based on Medicare average drug cost. Actual cost varies by pharmacy and dosage.'
    }));

  } catch(err) {
    console.error('Drug cost error:', err);
    try { res.writeHead(500); res.end(JSON.stringify({ estimated_oop: null })); } catch(e) {}
  }
}

// GET /api/drugs/search?q=lisinopril&plan=H0609-073-000
async function drugSearch(req, res, db) {
  try {
    const params  = getParams(req);
    const query   = (params.get('q') || '').trim().toLowerCase();
    const planKey = parsePlanKey(params.get('plan') || '');

    res.writeHead(200, { 'Content-Type': 'application/json' });

    if (!query || query.length < 2) return res.end(JSON.stringify({ results: [] }));
    if (!planKey) return res.end(JSON.stringify({ results: [], message: 'No plan found' }));

    const planDoc = await db.collection('formulary_plans').findOne({ contract_plan_id: planKey });
    if (!planDoc) return res.end(JSON.stringify({ results: [], message: 'Plan not in formulary database' }));

    const formularyId = planDoc.formulary_id;

    // Get tier costs from ma_plans (more accurate than PUF beneficiary cost file)
    const maPlan = await db.collection('ma_plans').findOne({ planKey: planKey + '-000' });
    const tierCostsArr = (maPlan && maPlan.drugTiers) || [];
    const tierCosts = {};
    tierCostsArr.forEach(t => {
      tierCosts[String(t.tier)] = {
        preferred_retail: t.retail30 || null,
        standard_retail:  t.retail30 || null,
        mail_order:       t.mail90   || null,
      };
    });

    const drugs = await db.collection('formulary').find({
      formulary_id:    formularyId,
      drug_name_lower: { $regex: query, $options: 'i' }
    }).sort({ drug_name_lower: 1 }).limit(50).toArray();

    // Extract brand name from brackets e.g. "atorvastatin [Lipitor]" → "Lipitor"
    function getBrandName(name) {
      const match = (name || '').match(/\[([^\]]+)\]/);
      return match ? match[1] : null;
    }

    // Sort: brand starts-with first, generic starts-with second, contains last
    drugs.sort((a, b) => {
      const aBrand = (getBrandName(a.drug_name) || '').toLowerCase();
      const bBrand = (getBrandName(b.drug_name) || '').toLowerCase();
      const aStartsBrand   = aBrand && aBrand.startsWith(query);
      const bStartsBrand   = bBrand && bBrand.startsWith(query);
      const aStartsGeneric = a.drug_name_lower.startsWith(query);
      const bStartsGeneric = b.drug_name_lower.startsWith(query);
      if (aStartsBrand && !bStartsBrand) return -1;
      if (!aStartsBrand && bStartsBrand) return 1;
      if (aStartsGeneric && !bStartsGeneric) return -1;
      if (!aStartsGeneric && bStartsGeneric) return 1;
      return a.drug_name_lower.localeCompare(b.drug_name_lower);
    });

    const results = drugs.slice(0, 20).map(drug => {
      const brandName = getBrandName(drug.drug_name);
      const costs = tierCosts[String(drug.tier)] || {};
      return {
        drug_name:      brandName ? `${brandName} (${drug.drug_name.replace(/\s*\[[^\]]+\]/, '').trim()})` : drug.drug_name,
        drug_name_short: brandName || drug.drug_name,
        rxcui:          drug.rxcui,
        ndc:            drug.ndc,
        tier:           drug.tier,
        tier_label:     drug.tier_label,
        requires_pa:    drug.requires_pa,
        step_therapy:   drug.step_therapy,
        quantity_limit: drug.quantity_limit,
        selected_drug:  drug.selected_drug,
        pricing: {
          preferred_retail: costs.preferred_retail || null,
          standard_retail:  costs.standard_retail  || null,
          mail_order:       costs.mail_order        || null,
        },
        plan_name: planDoc.plan_name,
        plan_year: drug.plan_year,
      };
    });

    res.end(JSON.stringify({ results, plan_key: planKey }));

  } catch(err) {
    console.error('Drug search error:', err);
    try {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Drug search failed', detail: err.message }));
    } catch(e) {}
  }
}

// GET /api/drugs/plan-tiers?plan=H0609-073-000
async function planTiers(req, res, db) {
  try {
    const params  = getParams(req);
    const planKey = parsePlanKey(params.get('plan') || '');

    res.writeHead(200, { 'Content-Type': 'application/json' });

    if (!planKey) return res.end(JSON.stringify({ tiers: [] }));

    // Pull from ma_plans which has correct tier data from CMS PBP files
    const maPlan = await db.collection('ma_plans').findOne({ planKey: planKey + '-000' });
    if (!maPlan || !maPlan.drugTiers || !maPlan.drugTiers.length) {
      return res.end(JSON.stringify({ tiers: [] }));
    }

    const tiers = maPlan.drugTiers.map(t => ({
      tier:             t.tier,
      tier_label:       t.label,
      preferred_retail: t.retail30 || '—',
      standard_retail:  t.retail30 || '—',
      mail_order:       t.mail90   || '—',
    }));

    res.end(JSON.stringify({ plan_key: planKey, plan_name: maPlan.planName || '', tiers }));

  } catch(err) {
    console.error('Plan tiers error:', err);
    try {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to load tier data' }));
    } catch(e) {}
  }
}

module.exports = { drugSearch, planTiers, drugCost, parsePlanKey };
