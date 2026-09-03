const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');
const cron = require('node-cron');
const { drugSearch, planTiers, drugCost } = require('./drug-search-routes');

const PORT = process.env.PORT || 3000;
const ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID;
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'shs2026';
const ZOHO_API_BASE = 'https://www.zohoapis.com/crm/v6';

let cachedToken = null;
let tokenExpiry = 0;
let mongoClient = null;

async function getMongoClient() {
  if (mongoClient) return mongoClient;
  const { MongoClient } = require('mongodb');
  mongoClient = new MongoClient(process.env.MONGODB_URI);
  await mongoClient.connect();
  return mongoClient;
}

async function getPlanBenefits(mapdPlanNumber) {
  if (!mapdPlanNumber || !process.env.MONGODB_URI) return null;
  try {
    const client = await getMongoClient();
    const col = client.db('shs').collection('ma_plans');
    // Parse H0609-073-000 into contractId H0609 and planId 073
    const parts = mapdPlanNumber.replace(/\s/g,'').split('-');
    if (parts.length < 2) return null;
    const contractId = parts[0];
    const planId = parts[1];
    const plan = await col.findOne({ contractId, planId });
    return plan;
  } catch(e) {
    console.log('MongoDB benefits lookup error:', e.message);
    return null;
  }
}

function getAccessToken() {
  return new Promise((resolve, reject) => {
    if (cachedToken && Date.now() < tokenExpiry) {
      return resolve(cachedToken);
    }
    const body = `refresh_token=${ZOHO_REFRESH_TOKEN}&client_id=${ZOHO_CLIENT_ID}&client_secret=${ZOHO_CLIENT_SECRET}&grant_type=refresh_token`;
    const req = https.request({
      hostname: 'accounts.zoho.com',
      path: '/oauth/v2/token',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.access_token) {
            console.log('Zoho access token obtained successfully');
            cachedToken = json.access_token;
            tokenExpiry = Date.now() + (json.expires_in - 60) * 1000;
            resolve(cachedToken);
          } else {
            console.log('Zoho token error:', data);
            reject(new Error('Zoho auth failed: ' + data));
          }
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function zohoGet(path, token) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'www.zohoapis.com',
      path: path,
      method: 'GET',
      headers: { 'Authorization': 'Zoho-oauthtoken ' + token }
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        console.log('Zoho response status:', res.statusCode);
        console.log('Zoho response body:', data.substring(0, 300));
        if (!data || data.trim() === '') {
          return resolve({ data: null, empty: true, status: res.statusCode });
        }
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Zoho parse error: ' + data.substring(0, 200))); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function getClientData(anyId) {
  const token = await getAccessToken();
  let contact = null;
  let contactId = anyId;

  // Step 1: Try as a Contact directly
  console.log('Trying as Contact:', anyId);
  const contactRes = await zohoGet(
    `/crm/v6/Contacts/${anyId}?fields=First_Name,Last_Name,Phone,Mobile,Email,Date_of_Birth,Mailing_City,Mailing_State,Owner,Owner_s_Phone`,
    token
  );
  if (contactRes.data && contactRes.data[0]) {
    contact = contactRes.data[0];
    contactId = contact.id;
    console.log('Found as Contact:', contact.First_Name, contact.Last_Name);
  }

  // Step 2: Try as a Potential (policy) — find the linked Contact
  if (!contact) {
    console.log('Trying as Potential:', anyId);
    const potentialRes = await zohoGet(
      `/crm/v6/Potentials/${anyId}?fields=Deal_Name,Contact_Name`,
      token
    );
    if (potentialRes.data && potentialRes.data[0] && potentialRes.data[0].Contact_Name) {
      const linkedContactId = potentialRes.data[0].Contact_Name.id;
      console.log('Found as Potential, linked Contact ID:', linkedContactId);
      const linkedContactRes = await zohoGet(
        `/crm/v6/Contacts/${linkedContactId}?fields=First_Name,Last_Name,Phone,Mobile,Email,Date_of_Birth,Mailing_City,Mailing_State,Owner,Owner_s_Phone`,
        token
      );
      if (linkedContactRes.data && linkedContactRes.data[0]) {
        contact = linkedContactRes.data[0];
        contactId = linkedContactId;
        console.log('Found Contact via Potential:', contact.First_Name, contact.Last_Name);
      }
    }
  }

  // Step 3: Try as a Lead
  if (!contact) {
    console.log('Trying as Lead:', anyId);
    const leadRes = await zohoGet(
      `/crm/v6/Leads/${anyId}?fields=First_Name,Last_Name,Phone,Mobile,Email,City,State,Owner`,
      token
    );
    if (leadRes.data && leadRes.data[0]) {
      const lead = leadRes.data[0];
      console.log('Found as Lead:', lead.First_Name, lead.Last_Name);
      // Return lead with no policies
      return {
        id: lead.id,
        name: (lead.First_Name || '') + ' ' + (lead.Last_Name || ''),
        firstName: lead.First_Name || '',
        phone: lead.Phone || lead.Mobile || '',
        mobile: lead.Mobile || '',
        email: lead.Email || '',
        dob: '',
        address: [lead.City, lead.State].filter(Boolean).join(', '),
        medicareId: '',
        agent: lead.Owner ? lead.Owner.name : 'Your Agent',
        policies: []
      };
    }
  }

  if (!contact) throw new Error('Could not find a Contact, Potential, or Lead with that ID. Please check the ID and try again.');

  // Fetch all linked policies from Potentials
  const policiesRes = await zohoGet(
    `/crm/v6/Potentials/search?criteria=(Contact_Name:equals:${contactId})&fields=Deal_Name,Coverage_Type,Insurance_Company,Application_Date,Effective_Date,Stage,Policy_Number,MAPD_Plan_Number,Monthly_Premium,Annualized_Premium,Renewal_Date,Agent_Name,Policy_Owner&per_page=20`,
    token
  );
  console.log('Policies found:', policiesRes.data ? policiesRes.data.length : 0);

  const policies = policiesRes.data || [];

  // Look up benefits for MA plan — Active, Pending, or Internal Replacement statuses only
  const validStatuses = ['active', 'pending', 'internal replacement'];
  const maPolicy = 
    policies.find(p => p.Coverage_Type && p.Coverage_Type.toLowerCase().includes('medicare advantage') && p.MAPD_Plan_Number && p.MAPD_Plan_Number !== 'n/a' && p.MAPD_Plan_Number !== '' && validStatuses.includes((p.Stage || '').toLowerCase())) ||
    policies.find(p => p.Coverage_Type && p.Coverage_Type.toLowerCase().includes('medicare advantage') && validStatuses.includes((p.Stage || '').toLowerCase()));
  const mapdNum = maPolicy ? (maPolicy.MAPD_Plan_Number || '') : '';
  const planBenefits = mapdNum && mapdNum !== 'n/a' ? await getPlanBenefits(mapdNum) : null;

  // Get agent from the MA policy's Policy_Owner field
  const maPolicyOwner = maPolicy ? (maPolicy.Policy_Owner || '') : '';
  const agentName = maPolicyOwner || (contact.Owner ? contact.Owner.name : 'Your Agent');

  return {
    id: contact.id,
    name: (contact.First_Name || '') + ' ' + (contact.Last_Name || ''),
    firstName: contact.First_Name || '',
    phone: contact.Phone || contact.Mobile || '',
    email: contact.Email || '',
    dob: contact.Date_of_Birth || '',
    address: [contact.Mailing_City, contact.Mailing_State].filter(Boolean).join(', '),
    medicareId: contact.Medicare_ID || contact.Medicare_Number || '',
    agent: agentName,
    agentPhone: contact.Owner_s_Phone || contact.Owner_Phone || '',
    planBenefits: planBenefits ? {
      moop: planBenefits.moop,
      primaryCare: planBenefits.benefits && planBenefits.benefits.primaryCare,
      specialist: planBenefits.benefits && planBenefits.benefits.specialist,
      urgentCare: planBenefits.benefits && planBenefits.benefits.urgentCare,
      emergencyRoom: planBenefits.benefits && planBenefits.benefits.emergencyRoom,
      preventive: planBenefits.benefits && planBenefits.benefits.preventive,
      labServices: planBenefits.benefits && planBenefits.benefits.labServices,
      ambulance: planBenefits.benefits && planBenefits.benefits.ambulance,
      dental: planBenefits.benefits && planBenefits.benefits.dental,
      vision: planBenefits.benefits && planBenefits.benefits.vision,
      hearing: planBenefits.benefits && planBenefits.benefits.hearing,
      otc: planBenefits.benefits && planBenefits.benefits.otc,
      telehealth: planBenefits.benefits && planBenefits.benefits.telehealth,
      chiropractic: planBenefits.benefits && planBenefits.benefits.chiropractic,
      physicalTherapy: planBenefits.benefits && planBenefits.benefits.physicalTherapy,
      drugTiers: planBenefits.drugTiers || [],
    } : null,
    policies: policies.map(p => ({
      name: p.Deal_Name || '',
      type: p.Coverage_Type || '',
      carrier: p.Insurance_Company || '',
      policyNumber: p.Policy_Number || '',
      mapdPlanNumber: p.MAPD_Plan_Number || '',
      premium: p.Monthly_Premium || (p.Annualized_Premium ? p.Annualized_Premium / 12 : 0),
      effectiveDate: p.Effective_Date || '',
      renewalDate: p.Renewal_Date || '',
      agentName: p.Policy_Owner || p.Agent_Name || '',
      status: p.Stage || 'Active'
    }))
  };
}

function serveAdmin(res, pw) {
  const safePw = (pw || '').replace(/'/g, "\\\\'" );
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SHS Admin — Generate Client Links</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #f0f3f8; min-height: 100vh; padding: 40px 20px; }
  .wrap { max-width: 680px; margin: 0 auto; }
  .header { background: #1a2a4a; border-radius: 16px; padding: 24px 28px; margin-bottom: 24px; }
  .header h1 { color: #d4a017; font-size: 13px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; margin-bottom: 6px; }
  .header p { color: #fff; font-size: 20px; font-weight: 600; }
  .card { background: #fff; border-radius: 16px; border: 1px solid #e0e6f0; padding: 24px; margin-bottom: 16px; }
  .card h2 { font-size: 13px; font-weight: 700; color: #1a2a4a; opacity: 0.6; text-transform: uppercase; letter-spacing: 0.4px; margin-bottom: 16px; }
  label { font-size: 13px; color: #6b7fa0; display: block; margin-bottom: 6px; }
  input { width: 100%; padding: 12px 14px; border: 1px solid #e0e6f0; border-radius: 10px; font-size: 15px; margin-bottom: 16px; outline: none; }
  input:focus { border-color: #1a2a4a; }
  .btn { background: #1a2a4a; color: #fff; border: none; border-radius: 10px; padding: 13px 24px; font-size: 15px; font-weight: 500; cursor: pointer; width: 100%; }
  .btn:hover { background: #2a4070; }
  .result { background: #e4f6ee; border: 1px solid #b0dfc0; border-radius: 12px; padding: 16px; margin-top: 16px; display: none; }
  .result h3 { font-size: 14px; font-weight: 600; color: #1a6e42; margin-bottom: 10px; }
  .client-name { font-size: 20px; font-weight: 700; color: #1a2a4a; margin-bottom: 4px; }
  .policy-count { font-size: 13px; color: #6b7fa0; margin-bottom: 14px; }
  .link-box { background: #fff; border: 1px solid #b0dfc0; border-radius: 8px; padding: 12px; font-size: 13px; color: #1a2a4a; word-break: break-all; margin-bottom: 10px; }
  .copy-btn { background: #1a2a4a; color: #fff; border: none; border-radius: 8px; padding: 10px 20px; font-size: 13px; cursor: pointer; margin-right: 8px; }
  .sms-btn { background: #d4a017; color: #fff; border: none; border-radius: 8px; padding: 10px 20px; font-size: 13px; cursor: pointer; text-decoration: none; display: inline-block; }
  .error { background: #fce8e8; border: 1px solid #f5c0c0; border-radius: 12px; padding: 16px; margin-top: 16px; color: #a03030; font-size: 14px; display: none; }
  .tip { background: #fef6e4; border-radius: 10px; padding: 12px 14px; font-size: 13px; color: #7a5000; line-height: 1.6; }
  .loading { text-align: center; color: #6b7fa0; font-size: 14px; margin-top: 16px; display: none; }
</style>
</head>
<body>
<div class="wrap">
  <div class="header">
    <h1>Senior Health Solutions</h1>
    <p>Client App Link Generator</p>
  </div>

  <div class="card">
    <h2>Generate a client link</h2>
    <div class="tip" style="margin-bottom:20px;">
      Open the client's record in Zoho CRM. Copy the long number at the end of the URL in your browser. Paste it below.
      <br><br>Example URL:<br><span style="word-break:break-all;font-size:12px;">zoho.com/crm/org123/tab/Contacts/<strong>4567891234567890123</strong></span>
    </div>
    <label>Zoho CRM Contact ID</label>
    <input type="text" id="contact-id" placeholder="e.g. 4567891234567890123" />
    <button class="btn" onclick="generateLink()">Look up client and generate link</button>
    <div class="loading" id="loading">Looking up client in Zoho CRM...</div>
    <div class="error" id="error"></div>
    <div class="result" id="result">
      <h3>Link ready to send</h3>
      <div class="client-name" id="client-name"></div>
      <div class="policy-count" id="policy-count"></div>
      <div class="link-box" id="link-box"></div>
      <button class="copy-btn" onclick="copyLink()">Copy link</button>
      <a class="sms-btn" id="sms-link" href="#">Open in Messages</a>
    </div>
  </div>

  <div class="card">
    <h2>How to use</h2>
    <div style="display:flex;flex-direction:column;gap:10px;">
      <div style="display:flex;gap:12px;align-items:flex-start;">
        <div style="width:24px;height:24px;background:#1a2a4a;border-radius:50%;color:#d4a017;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;">1</div>
        <div style="font-size:14px;color:#1a2a4a;padding-top:3px;">Open the client record in Zoho CRM and copy their Contact ID from the URL</div>
      </div>
      <div style="display:flex;gap:12px;align-items:flex-start;">
        <div style="width:24px;height:24px;background:#1a2a4a;border-radius:50%;color:#d4a017;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;">2</div>
        <div style="font-size:14px;color:#1a2a4a;padding-top:3px;">Paste it above and click Generate — we pull their name and policies from Zoho automatically</div>
      </div>
      <div style="display:flex;gap:12px;align-items:flex-start;">
        <div style="width:24px;height:24px;background:#1a2a4a;border-radius:50%;color:#d4a017;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;">3</div>
        <div style="font-size:14px;color:#1a2a4a;padding-top:3px;">Tap "Open in Messages" to text the link directly to the client — or copy and paste it anywhere</div>
      </div>
      <div style="display:flex;gap:12px;align-items:flex-start;">
        <div style="width:24px;height:24px;background:#1a2a4a;border-radius:50%;color:#d4a017;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;">4</div>
        <div style="font-size:14px;color:#1a2a4a;padding-top:3px;">Client taps the link, sees their real coverage, saves to home screen — done</div>
      </div>
    </div>
  </div>
</div>

<script>
let generatedLink = '';
let clientPhone = '';

const PW = '${safePw}';
async function generateLink() {
  const id = document.getElementById('contact-id').value.trim();
  if (!id) { showError('Please enter a Zoho Contact ID'); return; }
  document.getElementById('loading').style.display = 'block';
  document.getElementById('result').style.display = 'none';
  document.getElementById('error').style.display = 'none';
  try {
    const res = await fetch('/api/client/' + id + '/preview?pw=' + encodeURIComponent(PW));
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error looking up client');
    const baseUrl = window.location.origin;
    generatedLink = baseUrl + '/client/' + id;
    clientPhone = data.phone || '';
    document.getElementById('client-name').textContent = data.name;
    document.getElementById('policy-count').textContent = data.policyCount + ' policies found in Zoho CRM';
    document.getElementById('link-box').textContent = generatedLink;
    const msg = encodeURIComponent('Hi ' + data.firstName + ', here is your Senior Health Solutions coverage app — tap to open and save to your home screen: ' + generatedLink);
    document.getElementById('sms-link').href = 'sms:' + clientPhone + '&body=' + msg;
    document.getElementById('result').style.display = 'block';
  } catch(e) {
    showError(e.message);
  }
  document.getElementById('loading').style.display = 'none';
}

function showError(msg) {
  const el = document.getElementById('error');
  el.textContent = msg;
  el.style.display = 'block';
  document.getElementById('loading').style.display = 'none';
}

function copyLink() {
  navigator.clipboard.writeText(generatedLink);
  const btn = document.querySelector('.copy-btn');
  btn.textContent = 'Copied!';
  setTimeout(() => btn.textContent = 'Copy link', 2000);
}
</script>
</body>
</html>`;
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(html);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve(JSON.parse(body));
      } catch(e) { resolve({}); }
    });
    req.on('error', reject);
  });
}

function checkAdmin(req, url) {
  const adminPw = process.env.ADMIN_PASSWORD || 'shs2026';
  const headerPw = req.headers['x-admin-password'] || '';
  const urlPw = url && url.includes('?') ? new URLSearchParams(url.split('?')[1]).get('pw') || '' : '';
  return headerPw === adminPw || urlPw === adminPw;
}

const server = http.createServer(async (req, res) => {
  const url = req.url;

  res.setHeader('Access-Control-Allow-Origin', '*');

  if (url === '/admin' || url.startsWith('/admin?')) {
    const urlParams = new URLSearchParams(url.includes('?') ? url.split('?')[1] : '');
    const pw = urlParams.get('pw') || req.headers['x-admin-password'] || '';
    const adminPw = process.env.ADMIN_PASSWORD || 'shs2026';
    if (pw !== adminPw) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="apple-mobile-web-app-capable" content="yes"><title>SHS Admin</title></head><body style="font-family:-apple-system,sans-serif;padding:40px 20px;max-width:400px;margin:0 auto;background:#f0f3f8;min-height:100vh;">
        <div style="background:#1a2a4a;border-radius:16px;padding:24px;margin-bottom:24px;"><div style="color:#d4a017;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px;">Senior Health Solutions</div><div style="color:#fff;font-size:20px;font-weight:600;">Admin Login</div></div>
        <div style="background:#fff;border-radius:16px;border:1px solid #e0e6f0;padding:24px;">
          <label style="font-size:13px;color:#6b7fa0;display:block;margin-bottom:6px;">Password</label>
          <input type="password" id="pw" placeholder="Enter admin password" style="width:100%;padding:12px 14px;border:1px solid #e0e6f0;border-radius:10px;font-size:16px;margin-bottom:16px;outline:none;" />
          <button onclick="login()" style="background:#1a2a4a;color:#fff;border:none;border-radius:10px;padding:13px 24px;font-size:16px;font-weight:500;cursor:pointer;width:100%;">Log in</button>
          ${urlParams.get('err') ? '<div style="color:#a03030;font-size:13px;margin-top:12px;text-align:center;">Wrong password — try again</div>' : ''}
        </div>
        <script>
          function login() {
            const pw = document.getElementById('pw').value;
            window.location.href = '/admin?pw=' + encodeURIComponent(pw);
          }
          document.getElementById('pw').addEventListener('keypress', e => { if(e.key === 'Enter') login(); });
          document.getElementById('pw').focus();
        <\/script>
      </body></html>`);
    }
    return serveAdmin(res, pw);
  }

  if (url.startsWith('/api/client/') && url.includes('/preview')) {
    if (!checkAdmin(req, url)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unauthorized' }));
    }
    const contactId = url.replace('/api/client/', '').replace('/preview', '').split('?')[0];
    try {
      const data = await getClientData(contactId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        name: data.name,
        firstName: data.firstName,
        phone: data.phone,
        policyCount: data.policies.length
      }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (url.startsWith('/api/client/')) {
    const contactId = url.replace('/api/client/', '').split('?')[0];
    try {
      const data = await getClientData(contactId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(data));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (url.startsWith('/client/')) {
    const contactId = url.replace('/client/', '').split('?')[0];
    const clientHtml = fs.readFileSync(path.join(__dirname, 'client.html'), 'utf8')
      .replace('__CONTACT_ID__', contactId);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(clientHtml);
  }

  if (url === '/api/explain-eob' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const imageData = body.image;
      const mimeType = body.mimeType || 'image/jpeg';
      if (!imageData) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'No image provided' }));
      }

      const https = require('https');
      const requestBody = JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mimeType, data: imageData }
            },
            {
              type: 'text',
              text: 'This is a Medicare Explanation of Benefits (EOB) document. Please explain it in very simple plain English for a senior citizen. Focus on: 1) What service was provided, 2) What the doctor billed, 3) What the insurance plan paid, 4) What the patient owes (if anything), and 5) Whether this amount looks correct based on typical Medicare Advantage copays. Do NOT store or repeat any personal information like names, member IDs, or social security numbers. Keep the explanation friendly, clear, and under 200 words. Start with whether this is a bill or not.'
            }
          ]
        }]
      });

      const apiReq = https.request({
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY || '',
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(requestBody)
        }
      }, apiRes => {
        let data = '';
        apiRes.on('data', d => data += d);
        apiRes.on('end', () => {
          try {
            console.log('Anthropic response status:', apiRes.statusCode);
            console.log('Anthropic response body:', data.substring(0, 200));
            const json = JSON.parse(data);
            if (json.error) {
              console.log('Anthropic error:', json.error);
              res.writeHead(500, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ error: json.error.message || 'API error' }));
            }
            const explanation = json.content && json.content[0] && json.content[0].text;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ explanation: explanation || 'Could not read this document. Please call your agent for help.' }));
          } catch(e) {
            console.log('EOB parse error:', e.message, data.substring(0, 100));
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Could not analyze EOB' }));
          }
        });
      });
      apiReq.on('error', e => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      });
      apiReq.write(requestBody);
      apiReq.end();
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.startsWith('/diagnostic/contact/')) {
    const contactId = url.replace('/diagnostic/contact/', '').split('?')[0];
    try {
      const token = await getAccessToken();
      const data = await getClientData(contactId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(data, null, 2));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (url.startsWith('/diagnostic/plan/')) {
    const planKey = url.replace('/diagnostic/plan/', '').split('?')[0];
    try {
      const client = await getMongoClient();
      const col = client.db('shs').collection('ma_plans');
      const parts = planKey.split('-');
      const plan = await col.findOne({ contractId: parts[0], planId: parts[1] });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(plan, null, 2));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (url === '/diagnostic') {
    try {
      const token = await getAccessToken();
      const test = await zohoGet('/crm/v6/Contacts?fields=First_Name,Last_Name&per_page=2', token);
      
      // Test MongoDB connection
      let mongoStatus = 'not configured';
      let mongoDetails = '';
      if (process.env.MONGODB_URI) {
        try {
          const { MongoClient } = require('mongodb');
          const client = new MongoClient(process.env.MONGODB_URI);
          await client.connect();
          const db = client.db('shs');
          const collections = await db.listCollections().toArray();
          const planCount = collections.find(c => c.name === 'ma_plans') 
            ? await db.collection('ma_plans').countDocuments() 
            : 0;
          mongoStatus = 'connected';
          mongoDetails = planCount + ' plans in database';
          await client.close();
        } catch(me) {
          mongoStatus = 'error: ' + me.message;
        }
      }
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ 
        status: 'ok', 
        zoho: 'connected',
        contacts: test,
        mongodb: mongoStatus,
        mongoDetails
      }, null, 2));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'error', message: e.message }));
    }
  }

  // Drug formulary search
  if (url.startsWith('/api/drugs/search')) {
    const client = await getMongoClient();
    return drugSearch(req, res, client.db('shs'));
  }

  // Plan tier structure
  if (url.startsWith('/api/drugs/plan-tiers')) {
    const client = await getMongoClient();
    return planTiers(req, res, client.db('shs'));
  }

  // Drug estimated out of pocket
  if (url.startsWith('/api/drugs/cost')) {
    const client = await getMongoClient();
    return drugCost(req, res, client.db('shs'));
  }

  // Manual formulary refresh trigger (admin only)
  if (url.startsWith('/admin/refresh-formulary') && req.method === 'POST') {
    if (!checkAdmin(req, url)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unauthorized' }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'Formulary refresh started in background' }));
    setTimeout(() => {
      try {
        const { execSync } = require('child_process');
        execSync('node import-cms-puf.js', { env: { ...process.env }, stdio: 'inherit', timeout: 30 * 60 * 1000 });
        console.log('✅ Manual formulary refresh complete');
      } catch (err) {
        console.error('❌ Manual formulary refresh failed:', err.message);
      }
    }, 100);
    return;
  }

  const filePath = path.join(__dirname, 'index.html');
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(500); return res.end('Error'); }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(data);
  });
});

server.listen(PORT, () => console.log(`SHS app running on port ${PORT}`));

// Monthly CMS formulary refresh — runs 1st of every month at 6am UTC
cron.schedule('0 6 1 * *', () => {
  console.log('🔄 Monthly CMS formulary refresh starting...');
  try {
    const { execSync } = require('child_process');
    execSync('node import-cms-puf.js', { env: { ...process.env }, stdio: 'inherit', timeout: 30 * 60 * 1000 });
    console.log('✅ Monthly CMS formulary refresh complete');
  } catch (err) {
    console.error('❌ Monthly CMS formulary refresh failed:', err.message);
  }
});
