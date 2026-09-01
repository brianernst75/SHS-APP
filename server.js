const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');

const PORT = process.env.PORT || 3000;
const ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID;
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'shs2026';
const ZOHO_API_BASE = 'https://www.zohoapis.com/crm/v6';

let cachedToken = null;
let tokenExpiry = 0;

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
    `/crm/v6/Potentials/search?criteria=(Contact_Name:equals:${contactId})&fields=Deal_Name,Coverage_Type,Insurance_Company,Application_Date,Effective_Date,Stage,Policy_Number,MAPD_Plan_Number,Monthly_Premium,Annualized_Premium,Renewal_Date,Agent_Name&per_page=20`,
    token
  );
  console.log('Policies found:', policiesRes.data ? policiesRes.data.length : 0);

  const policies = policiesRes.data || [];

  return {
    id: contact.id,
    name: (contact.First_Name || '') + ' ' + (contact.Last_Name || ''),
    firstName: contact.First_Name || '',
    phone: contact.Phone || contact.Mobile || '',
    email: contact.Email || '',
    dob: contact.Date_of_Birth || '',
    address: [contact.Mailing_City, contact.Mailing_State].filter(Boolean).join(', '),
    medicareId: contact.Medicare_ID || contact.Medicare_Number || '',
    agent: contact.Owner ? contact.Owner.name : 'Your Agent',
    agentPhone: contact.Owner_s_Phone || contact.Owner_Phone || '',
    policies: policies.map(p => ({
      name: p.Deal_Name || '',
      type: p.Coverage_Type || '',
      carrier: p.Insurance_Company || '',
      policyNumber: p.Policy_Number || '',
      mapdPlanNumber: p.MAPD_Plan_Number || '',
      premium: p.Monthly_Premium || (p.Annualized_Premium ? p.Annualized_Premium / 12 : 0),
      effectiveDate: p.Effective_Date || '',
      renewalDate: p.Renewal_Date || '',
      agentName: p.Agent_Name || '',
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
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch(e) { resolve({}); }
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

  if (url === '/diagnostic') {
    try {
      const token = await getAccessToken();
      // Try to list first 2 contacts to verify scope and org
      const test = await zohoGet('/crm/v6/Contacts?fields=First_Name,Last_Name&per_page=2', token);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok', token: 'valid', contacts: test }, null, 2));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'error', message: e.message }));
    }
  }

  const filePath = path.join(__dirname, 'index.html');
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(500); return res.end('Error'); }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(data);
  });
});

server.listen(PORT, () => console.log(`SHS app running on port ${PORT}`));
