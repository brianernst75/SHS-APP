/**
 * ADD TO YOUR server.js
 * =====================
 * This shows exactly where/how to wire up drug search.
 * Search for the comment markers and paste in the relevant blocks.
 */


// ════════════════════════════════════════════════════════════════════════════
// BLOCK 1: Add near the top of server.js with other requires
// ════════════════════════════════════════════════════════════════════════════

const { drugSearch, planTiers } = require('./drug-search-routes');


// ════════════════════════════════════════════════════════════════════════════
// BLOCK 2: Add with your other app.get() routes
// ════════════════════════════════════════════════════════════════════════════

// Drug formulary search
app.get('/api/drugs/search', async (req, res) => {
  await drugSearch(req, res, db);  // db = your existing MongoDB db object
});

// Plan tier structure
app.get('/api/drugs/plan-tiers', async (req, res) => {
  await planTiers(req, res, db);
});


// ════════════════════════════════════════════════════════════════════════════
// BLOCK 3: Monthly auto-refresh cron (add after your DB connects)
// Uses node-cron — add to package.json: "node-cron": "^3.0.0"
// ════════════════════════════════════════════════════════════════════════════

const cron = require('node-cron');

// Run on 1st of every month at 6am UTC
// (CMS typically releases new files around the 26th-29th of the prior month)
cron.schedule('0 6 1 * *', async () => {
  console.log('🔄 Monthly CMS PUF refresh starting...');
  try {
    const { execSync } = require('child_process');
    execSync('node import-cms-puf.js', { 
      env: { ...process.env },
      stdio: 'inherit',
      timeout: 30 * 60 * 1000  // 30 min timeout
    });
    console.log('✅ Monthly CMS PUF refresh complete');
  } catch (err) {
    console.error('❌ Monthly CMS PUF refresh failed:', err.message);
    // TODO: send alert email/Slack here
  }
});


// ════════════════════════════════════════════════════════════════════════════
// BLOCK 4: Admin endpoint to manually trigger refresh
// Hit: POST /admin/refresh-formulary?pw=shs2026
// ════════════════════════════════════════════════════════════════════════════

app.post('/admin/refresh-formulary', async (req, res) => {
  if (req.query.pw !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.json({ message: 'Formulary refresh started in background' });
  
  // Run async so HTTP response returns immediately
  setTimeout(async () => {
    try {
      const { execSync } = require('child_process');
      execSync('node import-cms-puf.js', { 
        env: { ...process.env },
        stdio: 'inherit',
        timeout: 30 * 60 * 1000
      });
      console.log('✅ Manual formulary refresh complete');
    } catch (err) {
      console.error('❌ Manual formulary refresh failed:', err.message);
    }
  }, 100);
});
