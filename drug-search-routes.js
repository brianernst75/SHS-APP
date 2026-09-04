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
const drugCostCache = {};

async function getCmsDrugCost(drugName) {
  const cacheKey = drugName.toLowerCase().slice(0, 30);
  if (drugCostCache[cacheKey] !== undefined) return drugCostCache[cacheKey];

  // Extract brand name from brackets [Lipitor] or use first word as brand
  const bracketMatch = drugName.match(/\[([^\]]+)\]/);
  const brandName = bracketMatch ? bracketMatch[1] : drugName.split(' ')[0];

  // Try brand name first, then generic name
  const result = await queryCmsSpending(brandName) || await queryCmsSpending(drugName.split(' ')[0]);
  drugCostCache[cacheKey] = result;
  return result;
}

async function queryCmsSpending(name) {
  return new Promise(resolve => {
    // CMS Part D Spending dataset - correct ID and fields
    const encoded = encodeURIComponent(name.toUpperCase().slice(0, 30));
    const url = `https://data.cms.gov/data-api/v1/dataset/7e0b4365-fd63-4a29-8f5e-e0ac9f66a81b/data?filter[Brnd_Name]=${encoded}&filter[Mftr_Name]=Overall&size=1`;

    const req = https.get(url, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const rows = JSON.parse(data);
          if (rows && rows.length > 0) {
            // Avg_Spnd_Per_Clm_2024 = average cost per 30-day claim
            const avgPerClaim = parseFloat(rows[0].Avg_Spnd_Per_Clm_2024 || 0);
            resolve(avgPerClaim > 0 ? Math.round(avgPerClaim) : null);
          } else {
            resolve(null);
          }
        } catch(e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
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

    // Pull from ma_plans first (correct tier costs from CMS PBP files)
    const maPlan = await db.collection('ma_plans').findOne({ planKey: planKey + '-000' });
    const maTiers = (maPlan && maPlan.drugTiers) || [];

    // If ma_plans has 2+ tiers, use it directly
    if (maTiers.length >= 2) {
      const tiers = maTiers.map(t => ({
        tier:             t.tier,
        tier_label:       t.label,
        preferred_retail: t.retail30 || '—',
        standard_retail:  t.retail30 || '—',
        mail_order:       t.mail90   || '—',
      }));
      return res.end(JSON.stringify({ plan_key: planKey, plan_name: maPlan.planName || '', tiers }));
    }

    // Fallback: build tier table from formulary collection
    // Get distinct tiers for this plan and grab one drug per tier for pricing
    const planDoc = await db.collection('formulary_plans').findOne({ contract_plan_id: planKey });
    if (!planDoc) return res.end(JSON.stringify({ tiers: [] }));

    const formularyId = planDoc.formulary_id;

    // Get one drug per tier to extract pricing
    const tierDocs = await db.collection('formulary').aggregate([
      { $match: { formulary_id: formularyId, tier: { $gte: 1, $lte: 6 } } },
      { $sort: { tier: 1 } },
      { $group: {
          _id: '$tier',
          tier: { $first: '$tier' },
          tier_label: { $first: '$tier_label' },
          preferred_retail_copay: { $first: '$preferred_retail_copay' },
          preferred_retail_coins: { $first: '$preferred_retail_coins' },
          mail_copay: { $first: '$mail_copay' },
      }},
      { $sort: { _id: 1 } }
    ]).toArray();

    const tierLabels = {
      1: 'Tier 1 — Preferred Generic',
      2: 'Tier 2 — Generic',
      3: 'Tier 3 — Preferred Brand',
      4: 'Tier 4 — Non-Preferred Drug',
      5: 'Tier 5 — Specialty',
      6: 'Tier 6 — Select Care',
    };

    function formatCost(copay, coins) {
      if (copay > 0) return `$${copay}`;
      if (coins > 0) return `${Math.round(coins * 100)}%`;
      return '$0';
    }

    const tiers = tierDocs.map(t => ({
      tier:             t.tier,
      tier_label:       tierLabels[t.tier] || `Tier ${t.tier}`,
      preferred_retail: formatCost(t.preferred_retail_copay, t.preferred_retail_coins),
      standard_retail:  formatCost(t.preferred_retail_copay, t.preferred_retail_coins),
      mail_order:       t.mail_copay > 0 ? `$${t.mail_copay}` : '—',
    }));

    res.end(JSON.stringify({ plan_key: planKey, plan_name: planDoc.plan_name || '', tiers, source: 'formulary_fallback' }));

  } catch(err) {
    console.error('Plan tiers error:', err);
    try {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to load tier data' }));
    } catch(e) {}
  }
}

module.exports = { drugSearch, planTiers, drugCost, parsePlanKey };
