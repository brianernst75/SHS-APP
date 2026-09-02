/**
 * Drug Search API Routes
 * Add these to your existing server.js
 * 
 * Endpoints:
 *   GET /api/drugs/search?q=lisinopril&plan=H0609-073
 *   GET /api/drugs/lookup?ndc=12345678901&plan=H0609-073
 *   GET /api/drugs/plan-tiers?plan=H0609-073
 */

// ─── Helper: parse plan number from Zoho MAPD field ─────────────────────────
// Input:  "H0609-073-000" or "H0609-073"
// Output: "H0609-073"
function parsePlanKey(mapd) {
  if (!mapd || mapd === 'na') return null;
  const parts = mapd.split('-');
  if (parts.length >= 2) return `${parts[0]}-${parts[1].padStart(3,'0')}`;
  return null;
}

// ─── Format copay for display ────────────────────────────────────────────────
function formatCopay(copay, coins) {
  if (copay === null && coins === null) return null;
  if (copay === 0 && !coins) return '$0';
  if (copay > 0 && !coins) return `$${copay.toFixed(0)}`;
  if (!copay && coins > 0) return `${(coins * 100).toFixed(0)}%`;
  if (copay > 0 && coins > 0) return `$${copay.toFixed(0)} or ${(coins*100).toFixed(0)}%`;
  return '$0';
}

// ─── Drug Search ─────────────────────────────────────────────────────────────
// GET /api/drugs/search?q=lisinopril&plan=H0609-073-000
async function drugSearch(req, res, db) {
  try {
    const query  = (req.query.q || '').trim().toLowerCase();
    const planRaw = req.query.plan || '';
    const planKey = parsePlanKey(planRaw);

    if (!query || query.length < 2) {
      return res.json({ results: [], message: 'Enter at least 2 characters' });
    }
    if (!planKey) {
      return res.json({ results: [], message: 'No plan found' });
    }

    const collection = db.collection('formulary');

    // Search by drug name (prefix match first, then contains)
    const results = await collection.find({
      contract_plan_id: planKey,
      drug_name_lower: { $regex: query, $options: 'i' }
    })
    .sort({ drug_name_lower: 1 })
    .limit(20)
    .toArray();

    const formatted = results.map(drug => ({
      drug_name:     drug.drug_name,
      ndc:           drug.ndc,
      rxcui:         drug.rxcui,
      tier:          drug.tier,
      tier_label:    drug.tier_label,
      requires_pa:   drug.requires_pa,
      step_therapy:  drug.step_therapy,
      quantity_limit: drug.quantity_limit,
      selected_drug: drug.selected_drug,
      pricing: {
        preferred_retail: formatCopay(drug.preferred_retail_copay, drug.preferred_retail_coins),
        standard_retail:  formatCopay(drug.standard_retail_copay,  drug.standard_retail_coins),
        mail_order:       formatCopay(drug.mail_copay,             drug.mail_coins),
      },
      plan_name:  drug.plan_name,
      plan_year:  drug.plan_year,
    }));

    res.json({ results: formatted, plan_key: planKey, query });

  } catch (err) {
    console.error('Drug search error:', err);
    res.status(500).json({ error: 'Drug search failed' });
  }
}

// ─── Plan Tier Summary ────────────────────────────────────────────────────────
// GET /api/drugs/plan-tiers?plan=H0609-073-000
// Returns the 5 tier copays for a plan (for the "tier education" display)
async function planTiers(req, res, db) {
  try {
    const planKey = parsePlanKey(req.query.plan || '');
    if (!planKey) return res.status(400).json({ error: 'Invalid plan' });

    const collection = db.collection('formulary');

    // Get one drug per tier to extract cost structure
    const tiers = await collection.aggregate([
      { $match: { contract_plan_id: planKey } },
      { $group: {
          _id: '$tier',
          tier_label:             { $first: '$tier_label' },
          preferred_retail_copay: { $first: '$preferred_retail_copay' },
          preferred_retail_coins: { $first: '$preferred_retail_coins' },
          standard_retail_copay:  { $first: '$standard_retail_copay' },
          standard_retail_coins:  { $first: '$standard_retail_coins' },
          mail_copay:             { $first: '$mail_copay' },
          mail_coins:             { $first: '$mail_coins' },
          drug_count:             { $sum: 1 },
      }},
      { $sort: { _id: 1 } }
    ]).toArray();

    const formatted = tiers.map(t => ({
      tier:             t._id,
      tier_label:       t.tier_label,
      drug_count:       t.drug_count,
      preferred_retail: formatCopay(t.preferred_retail_copay, t.preferred_retail_coins),
      standard_retail:  formatCopay(t.standard_retail_copay,  t.standard_retail_coins),
      mail_order:       formatCopay(t.mail_copay,             t.mail_coins),
    }));

    res.json({ plan_key: planKey, tiers: formatted });

  } catch (err) {
    console.error('Plan tiers error:', err);
    res.status(500).json({ error: 'Failed to load tier data' });
  }
}

module.exports = { drugSearch, planTiers, parsePlanKey };
