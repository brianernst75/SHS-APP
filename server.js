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
            cachedToken = json.access_token;
            tokenExpiry = Date.now() + (json.expires_in - 60) * 1000;
            resolve(cachedToken);
          } else {
            reject(new Error('No access token: ' + data));
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
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function getClientData(contactId) {
  const token = await getAccessToken();
  const contactRes = await zohoGet(`/crm/v6/Contacts/${contactId}`, token);
  if (!contactRes.data || !contactRes.data[0]) throw new Error('Contact not found');
  const contact = contactRes.data[0];

  const policiesRes = await zohoGet(
    `/crm/v6/Potentials/search?criteria=(Contact_Name:equals:${contactId})&fields=Deal_Name,Coverage_Type,Insurance_Company,Application_Date,Stage,Policy_Number,Monthly_Premium,Closing_Date&per_page=20`,
    token
  );
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
    policies: policies.map(p => ({
      name: p.Deal_Name || '',
      type: p.Coverage_Type || '',
      carrier: p.Insurance_Company || '',
      policyNumber: p.Policy_Number || '',
      premium: p.Monthly_Premium || 0,
      effectiveDate: p.Application_Date || '',
      renewalDate: p.Closing_Date || '',
      status: p.Stage || 'Active'
    }))
  };
}

function serveAdmin(res) {
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
      <br><br>Example URL: zoho.com/crm/org123/tab/Contacts/<strong>4567891234567890123</strong>
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

async function generateLink() {
  const id = document.getElementById('contact-id').value.trim();
  if (!id) { showError('Please enter a Zoho Contact ID'); return; }
  document.getElementById('loading').style.display = 'block';
  document.getElementById('result').style.display = 'none';
  document.getElementById('error').style.display = 'none';
  try {
    const res = await fetch('/api/client/' + id + '/preview', {
      headers: { 'x-admin-password': document.getElementById('admin-pass') ? document.getElementById('admin-pass').value : '${ADMIN_PASSWORD}' }
    });
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

function checkAdmin(req) {
  const pw = req.headers['x-admin-password'];
  return pw === (process.env.ADMIN_PASSWORD || 'shs2026');
}

const server = http.createServer(async (req, res) => {
  const url = req.url;

  res.setHeader('Access-Control-Allow-Origin', '*');

  if (url === '/admin') {
    if (!checkAdmin(req)) {
      res.writeHead(401, { 'Content-Type': 'text/html' });
      return res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;max-width:400px;margin:0 auto;">
        <h2 style="color:#1a2a4a;">SHS Admin Login</h2>
        <input type="password" id="pw" placeholder="Enter admin password" style="width:100%;padding:12px;border:1px solid #ddd;border-radius:8px;font-size:16px;margin:16px 0;">
        <button onclick="login()" style="background:#1a2a4a;color:#fff;border:none;border-radius:8px;padding:12px 24px;font-size:16px;cursor:pointer;width:100%;">Login</button>
        <script>
          function login() {
            fetch('/admin', { headers: { 'x-admin-password': document.getElementById('pw').value }})
              .then(r => r.text()).then(html => document.open() || document.write(html) || document.close())
              .catch(() => alert('Wrong password'));
          }
          document.getElementById('pw').addEventListener('keypress', e => e.key === 'Enter' && login());
        <\/script>
      </body></html>`);
    }
    return serveAdmin(res);
  }

  if (url.startsWith('/api/client/') && url.endsWith('/preview')) {
    if (!checkAdmin(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unauthorized' }));
    }
    const contactId = url.replace('/api/client/', '').replace('/preview', '');
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
    const contactId = url.replace('/api/client/', '');
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
    const contactId = url.replace('/client/', '');
    const clientHtml = fs.readFileSync(path.join(__dirname, 'client.html'), 'utf8')
      .replace('__CONTACT_ID__', contactId);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(clientHtml);
  }

  const filePath = path.join(__dirname, 'index.html');
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(500); return res.end('Error'); }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(data);
  });
});

server.listen(PORT, () => console.log(`SHS app running on port ${PORT}`));
