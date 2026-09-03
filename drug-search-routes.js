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

// GET /api/drugs/search?q=lisinopril&plan=H0609-073-000
async function drugSearch(req, res, db) {
  try {
    const query   = (req.query.q || '').trim().toLowerCase();
    const planKey = parsePlanKey(req.query.plan || '');

    if (!query || query.length < 2) return res.end(JSON.stringify({ results: [] }));
    if (!planKey) return res.end(JSON.stringify({ results: [], message: 'No plan found' }));

    // Look up formulary_id and tier costs for this plan
    const planDoc = await db.collection('formulary_plans').findOne({ contract_plan_id: planKey });
    if (!planDoc) return res.end(JSON.stringify({ results: [], message: 'Plan not in formulary database' }));

    const formularyId = planDoc.formulary_id;
    const tierCosts   = planDoc.tier_costs || {};

    // Search drugs in this formulary
    const drugs = await db.collection('formulary').find({
      formulary_id:    formularyId,
      drug_name_lower: { $regex: query, $options: 'i' }
    }).sort({ drug_name_lower: 1 }).limit(20).toArray();

    const results = drugs.map(drug => {
      const costs = (tierCosts[drug.tier] || {});
      return {
        drug_name:      drug.drug_name || drug.rxcui,
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
        plan_name:  planDoc.plan_name,
        plan_year:  drug.plan_year,
      };
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ results, plan_key: planKey }));

  } catch(err) {
    console.error('Drug search error:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Drug search failed' }));
  }
}

// GET /api/drugs/plan-tiers?plan=H0609-073-000
async function planTiers(req, res, db) {
  try {
    const planKey = parsePlanKey(req.query.plan || '');
    if (!planKey) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Invalid plan' }));
    }

    const planDoc = await db.collection('formulary_plans').findOne({ contract_plan_id: planKey });
    if (!planDoc) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ tiers: [] }));
    }

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
        preferred_retail: tierCosts[t].preferred_retail || '—',
        standard_retail:  tierCosts[t].standard_retail  || '—',
        mail_order:       tierCosts[t].mail_order        || '—',
      }));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ plan_key: planKey, plan_name: planDoc.plan_name, tiers }));

  } catch(err) {
    console.error('Plan tiers error:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to load tier data' }));
  }
}

module.exports = { drugSearch, planTiers, parsePlanKey };
