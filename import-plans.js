/**
 * SHS Medicare App — CMS PBP Benefits Import Script v2
 * Usage: node import-plans.js /path/to/pbp-json-folder
 */

const fs = require('fs');
const path = require('path');

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) { console.error('ERROR: MONGODB_URI not set'); process.exit(1); }

const jsonFolder = process.argv[2];
if (!jsonFolder || !fs.existsSync(jsonFolder)) { console.error('ERROR: Folder not found:', jsonFolder); process.exit(1); }

// Periodicity codes
const PERIOD = { '1': '/month', '2': '/quarter', '3': '/year', '4': '/lifetime', '7': '/month', '8': '/2 years' };

function fmtCopay(copay) {
  if (!copay) return null;
  const v = copay.bdCopaymentAmountYesNoMinMax;
  if (v === '1' && copay.bdCopaymentAmount) return '$' + parseFloat(copay.bdCopaymentAmount).toFixed(0);
  if (v === '2') return '$0';
  if (v === '3') {
    const mn = parseFloat(copay.bdCopaymentMinAmount || 0);
    const mx = parseFloat(copay.bdCopaymentMaxAmount || 0);
    if (mn === 0 && mx === 0) return '$0';
    if (mn === mx) return '$' + mn.toFixed(0);
    return '$' + mn.toFixed(0) + '–$' + mx.toFixed(0);
  }
  // No value set = not covered or $0 based on context
  return null;
}

function fmtCoinsurance(coins) {
  if (!coins) return null;
  const v = coins.bdCoinsuranceAmountYesNoMinMax;
  if (v === '1' && coins.bdCoinsuranceAmount) return coins.bdCoinsuranceAmount + '%';
  if (v === '2') return '$0';
  if (v === '3') {
    const mn = parseFloat(coins.bdCoinsuranceMinAmount || 0);
    const mx = parseFloat(coins.bdCoinsuranceMaxAmount || 0);
    if (mn === 0 && mx === 0) return '0%';
    if (mn === mx) return mn + '%';
    return mn + '%–' + mx + '%';
  }
  return null;
}

function fmtMax(comp) {
  if (!comp) return null;
  if (comp.bdMaxPlanBenefitCovAmtYesNo === '1' && comp.bdMaxPlanBenefitCovAmt && parseFloat(comp.bdMaxPlanBenefitCovAmt) > 0) {
    const period = PERIOD[comp.bdMaxPlanBenefitCovPeriodicity] || '/year';
    return '$' + parseFloat(comp.bdMaxPlanBenefitCovAmt).toFixed(0) + period;
  }
  return null;
}

function fmtVisits(comp) {
  if (!comp) return null;
  if (comp.bdBenefitUnlimitedYesNo === '1') return 'Unlimited';
  if (comp.bdIndicateNumOfVisit) {
    const period = PERIOD[comp.bdBenefitUnlimitedPeriodicity] || '/year';
    return comp.bdIndicateNumOfVisit + ' visits' + period;
  }
  return null;
}

function parsePlan(json) {
  const pbp = json.pbp && json.pbp[0];
  if (!pbp) return null;

  const chars = pbp.planCharacteristics || {};
  const plan = {
    contractId:   pbp.contractId,
    planId:       pbp.planId,
    segmentId:    String(pbp.segmentId || 0).padStart(3, '0'),
    planKey:      `${pbp.contractId}-${pbp.planId}-${String(pbp.segmentId || 0).padStart(3, '0')}`,
    contractYear: json.contractYear || 2026,
    planName:     chars.planName || '',
    planType:     chars.planTypeLabel || '',
    carrier:      chars.organizationMarketingName || chars.contractLegalName || '',
    moop:         null,
    benefits:     {},
    updatedAt:    new Date(),
  };

  // MOOP
  const moopDetails = pbp.planLevelCostSharing &&
    pbp.planLevelCostSharing.maxEnrolleeCostLimit &&
    pbp.planLevelCostSharing.maxEnrolleeCostLimit.maxEnrolleeCostLimitDetails;
  if (moopDetails && moopDetails.inNWMoopAmount) {
    plan.moop = '$' + parseFloat(moopDetails.inNWMoopAmount).toFixed(0);
  }

  // Build lookup from benefitDetailsInfo
  const infoArr = pbp.benefitDetails && pbp.benefitDetails.benefitDetailsInfo;
  if (!Array.isArray(infoArr)) return plan;

  const byCode = {};
  for (const item of infoArr) {
    const code = item.categoryCode;
    if (!byCode[code]) byCode[code] = [];
    byCode[code].push(item.benefitDetails || {});
  }

  function getBenefit(codes) {
    for (const code of codes) {
      const arr = byCode[code];
      if (!arr) continue;
      for (const det of arr) {
        // Try standard CopaymentComponent
        let copay = fmtCopay(det.CopaymentComponent);
        
        // Try CopaymentAdmissionWaivedHospitalComponent (used for ER)
        if (!copay && det.CopaymentAdmissionWaivedHospitalComponent) {
          const inner = det.CopaymentAdmissionWaivedHospitalComponent.bdCopayComponent;
          copay = fmtCopay(inner);
        }
        
        // Try TierCopaymentComponent
        if (!copay && det.TierCopaymentComponent) {
          const tier = det.TierCopaymentComponent;
          if (tier.bdCopaymentAmountYesNo === '1' && tier.bdCopaymentTier1Amt) {
            copay = '$' + parseFloat(tier.bdCopaymentTier1Amt).toFixed(0);
          } else if (tier.bdCopaymentAmountYesNo === '2') {
            copay = '$0';
          }
          // Day interval (inpatient hospital)
          if (!copay && tier.bdCopaymentTier1DayIntervalStay) {
            const di = tier.bdCopaymentTier1DayIntervalStay;
            if (di.bdDayInterval1CopaymentAmount && parseFloat(di.bdDayInterval1CopaymentAmount) > 0) {
              copay = '$' + parseFloat(di.bdDayInterval1CopaymentAmount).toFixed(0) + '/day (days 1–' + di.bdDayInterval1EndDay + ')';
            } else if (di.bdDayInterval1CopaymentAmount === '0.00') {
              copay = '$0';
            }
          }
        }
        
        // Try CoinsuranceComponent if no copay
        if (!copay) {
          copay = fmtCoinsurance(det.CoinsuranceComponent);
        }
        
        // Check if CopaymentComponent yesno=2 means $0 explicitly  
        if (!copay && det.CopaymentComponent && det.CopaymentComponent.bdCopaymentAmountYesNoMinMax === '2') {
          copay = '$0';
        }

        const max = fmtMax(det.MaximumPlanBenefitCoverageComponent);
        const visits = fmtVisits(det.BenefitUnlimitedComponent);
        
        if (copay || max || visits) return { copay, maxBenefit: max, visits, code };
      }
    }
    return null;
  }

  plan.benefits.primaryCare     = getBenefit(['3-1']);
  plan.benefits.specialist       = getBenefit(['7c']);
  plan.benefits.urgentCare       = getBenefit(['5b']);
  plan.benefits.emergencyRoom    = getBenefit(['4c1', '4c']);
  plan.benefits.preventive       = getBenefit(['7i']);
  plan.benefits.labServices      = getBenefit(['7k']);
  plan.benefits.ambulance        = getBenefit(['6']);
  plan.benefits.mentalHealth     = getBenefit(['7d']);
  plan.benefits.telehealth       = getBenefit(['7j']);
  plan.benefits.dental           = getBenefit(['13a', '13b', '13c']);
  plan.benefits.vision           = getBenefit(['18a1', '18a']);
  plan.benefits.hearing          = getBenefit(['18b1', '18b']);
  plan.benefits.chiropractic     = getBenefit(['7b1']);
  plan.benefits.physicalTherapy  = getBenefit(['7h2', '7h1']);

  // OTC from combined supplemental
  const csg = pbp.costShareGroups || {};
  const csb = csg.combinedSupplementalBenefits || {};
  const groups = (csb.combinedSupplementalBenefitsDetails || {}).combNetworkGroupData || [];
  for (const g of groups) {
    const name = (g.combGroupName || '').toLowerCase();
    if ((name.includes('otc') || name.includes('grocery')) && g.maxPlanBenCovAmnt && parseFloat(g.maxPlanBenCovAmnt) > 0) {
      const period = PERIOD[g.combSuppBenMaxAmntPrdty] || '/year';
      plan.benefits.otc = { copay: null, maxBenefit: '$' + parseFloat(g.maxPlanBenCovAmnt).toFixed(0) + period, visits: null, code: 'otc' };
      break;
    }
  }

  return plan;
}

async function run() {
  const { MongoClient } = require('mongodb');
  console.log('Connecting to MongoDB...');
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  console.log('Connected');

  const col = client.db('shs').collection('ma_plans');
  await col.createIndex({ planKey: 1 }, { unique: true });
  await col.createIndex({ contractId: 1, planId: 1 });
  console.log('Indexes ready');

  const files = fs.readdirSync(jsonFolder).filter(f => f.endsWith('.json'));
  console.log(`Found ${files.length} JSON files`);

  let imported = 0, skipped = 0, errors = 0;
  const batchSize = 100;
  let batch = [];

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(jsonFolder, file), 'utf8');
      const json = JSON.parse(raw);
      const plan = parsePlan(json);
      if (!plan) { skipped++; continue; }
      batch.push({ updateOne: { filter: { planKey: plan.planKey }, update: { $set: plan }, upsert: true } });
      if (batch.length >= batchSize) {
        await col.bulkWrite(batch);
        imported += batch.length;
        batch = [];
        process.stdout.write(`\rImported: ${imported}...`);
      }
    } catch(e) { errors++; }
  }

  if (batch.length > 0) { await col.bulkWrite(batch); imported += batch.length; }

  console.log(`\n\nDone!`);
  console.log(`Imported: ${imported}`);
  console.log(`Skipped:  ${skipped}`);
  console.log(`Errors:   ${errors}`);
  console.log(`Total in MongoDB: ${await col.countDocuments()}`);
  await client.close();
}

run().catch(e => { console.error('Fatal error:', e.message); process.exit(1); });
