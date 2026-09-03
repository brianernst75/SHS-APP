/**
 * Drug Search API Routes
 * Uses two collections:
 *   formulary_plans — maps contract_plan_id → formulary_id + tier_costs
 *   formulary       — drugs indexed by formulary_id
 */

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
    const tierCosts   = planDoc.tier_costs || {};

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

    const planDoc = await db.collection('formulary_plans').findOne({ contract_plan_id: planKey });
    if (!planDoc) return res.end(JSON.stringify({ tiers: [] }));

    const tierCosts = planDoc.tier_costs || {};
    const tierLabels = {
      1: 'Tier 1 — Preferred Generic',
      2: 'Tier 2 — Generic',
      3: 'Tier 3 — Preferred Brand',
      4: 'Tier 4 — Non-Preferred Drug',
      5: 'Tier 5 — Specialty',
    };

    const tiers = Object.keys(tierCosts)
      .map(t => parseInt(t))
      .filter(t => t >= 1 && t <= 5)
      .sort()
      .map(t => ({
        tier:             t,
        tier_label:       tierLabels[t] || `Tier ${t}`,
        preferred_retail: tierCosts[String(t)].preferred_retail || '—',
        standard_retail:  tierCosts[String(t)].standard_retail  || '—',
        mail_order:       tierCosts[String(t)].mail_order        || '—',
      }));

    res.end(JSON.stringify({ plan_key: planKey, plan_name: planDoc.plan_name, tiers }));

  } catch(err) {
    console.error('Plan tiers error:', err);
    try {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to load tier data' }));
    } catch(e) {}
  }
}

module.exports = { drugSearch, planTiers, parsePlanKey };
