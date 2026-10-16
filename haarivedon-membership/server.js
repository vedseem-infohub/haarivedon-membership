'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

(function loadEnv() {
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

const PORT = Number(process.env.PORT) || 3000;
const KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const LEADS_WEBHOOK_URL = process.env.LEADS_WEBHOOK_URL || '';
const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const TOKEN_SECRET = KEY_SECRET || ADMIN_PASSWORD || process.env.TOKEN_SECRET || 'haarivedon-membership-secret-token';
const PUBLIC_DIR = path.join(__dirname, 'public');

// Resolve data storage location.
// In serverless environments (e.g. AWS Lambda, Vercel), /var/task is read-only.
// Attempting to write there throws "EROFS: read-only file system".
// In those environments we automatically route writes to os.tmpdir() (/tmp),
// cache in-memory, and sync to KV/webhook if configured.
function resolveDataFile() {
  if (process.env.DATA_FILE) return process.env.DATA_FILE;
  if (process.env.DATA_DIR) return path.join(process.env.DATA_DIR, 'leads.json');

  const isServerless = Boolean(
    process.env.VERCEL ||
    process.env.AWS_LAMBDA_FUNCTION_NAME ||
    process.env.LAMBDA_TASK_ROOT ||
    process.env.NETLIFY ||
    __dirname.startsWith('/var/task') ||
    __dirname.startsWith('/var/runtime')
  );

  if (isServerless) {
    return path.join(os.tmpdir(), 'leads.json');
  }

  const defaultDir = path.join(__dirname, 'data');
  try {
    fs.mkdirSync(defaultDir, { recursive: true });
    return path.join(defaultDir, 'leads.json');
  } catch (err) {
    if (err.code === 'EROFS' || err.code === 'EACCES') {
      return path.join(os.tmpdir(), 'leads.json');
    }
    return path.join(defaultDir, 'leads.json');
  }
}

let DATA_FILE = resolveDataFile();
let leadsCache = [];

(function initLeads() {
  const localFile = path.join(__dirname, 'data', 'leads.json');
  try {
    if (fs.existsSync(localFile)) {
      const data = JSON.parse(fs.readFileSync(localFile, 'utf8'));
      if (Array.isArray(data)) leadsCache = data;
    }
  } catch (_) { }
  try {
    if (DATA_FILE !== localFile && fs.existsSync(DATA_FILE)) {
      const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (Array.isArray(data) && data.length > leadsCache.length) leadsCache = data;
    }
  } catch (_) { }
})();

// Prices live on the server so they cannot be changed from the browser.
const PRODUCTS = {
  membership: { amount: 210000, name: 'Haarivedon 365-Day Membership', description: 'Festive Offer – 70% OFF (365 days)' },
  course: { amount: 510000, name: 'Draftsmanship Course', description: 'House/Property Layouting – 1 month (50% OFF)' },
};

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webp': 'image/webp', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8',
};

function readLeads() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const content = fs.readFileSync(DATA_FILE, 'utf8');
      const data = JSON.parse(content);
      if (Array.isArray(data)) {
        leadsCache = data;
        return data;
      }
    }
  } catch (e) {
    // Return cache if file read fails or file is not accessible
  }
  return leadsCache;
}

function syncLeadsToKv(leads) {
  if (!KV_URL || !KV_TOKEN) return;
  fetch(`${KV_URL}/set/leads`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(JSON.stringify(leads)),
  }).catch((e) => console.error('KV sync failed:', e.message));
}

async function fetchLeadsFromKv() {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const res = await fetch(`${KV_URL}/get/leads`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.result) return null;
    const parsed = typeof data.result === 'string' ? JSON.parse(data.result) : data.result;
    return Array.isArray(parsed) ? parsed : null;
  } catch (e) {
    console.error('KV fetch failed:', e.message);
    return null;
  }
}

function writeLeads(leads) {
  leadsCache = leads;
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = DATA_FILE + '.' + process.pid + '.' + Date.now() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(leads, null, 2));
    fs.renameSync(tmp, DATA_FILE);
  } catch (err) {
    if (err.code === 'EROFS' || err.code === 'EACCES' || err.code === 'EPERM') {
      console.warn(`Write to ${DATA_FILE} failed (${err.code}). Falling back to temporary directory.`);
      const fallbackFile = path.join(os.tmpdir(), 'leads.json');
      if (DATA_FILE !== fallbackFile) {
        DATA_FILE = fallbackFile;
        try {
          fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
          const tmp = DATA_FILE + '.' + process.pid + '.' + Date.now() + '.tmp';
          fs.writeFileSync(tmp, JSON.stringify(leads, null, 2));
          fs.renameSync(tmp, DATA_FILE);
        } catch (innerErr) {
          console.error('Failed to write leads to tmpdir fallback:', innerErr.message);
        }
      }
    } else {
      console.error('Failed to write leads file:', err.message);
    }
  }
  syncLeadsToKv(leads);
}

function createLeadToken(lead) {
  try {
    const payload = Buffer.from(JSON.stringify({
      id: lead.id,
      product: lead.product,
      name: lead.name,
      mobile: lead.mobile,
      address: lead.address,
      dob: lead.dob,
      amount: lead.amount,
      intent: lead.intent,
      createdAt: lead.createdAt,
    })).toString('base64url');
    const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');
    return `${payload}.${sig}`;
  } catch {
    return '';
  }
}

function verifyLeadToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function findOrRecoverLead(id, token) {
  if (!id) return null;
  const leads = readLeads();
  let lead = leads.find((l) => l.id === id);
  if (!lead && token) {
    const recovered = verifyLeadToken(token);
    if (recovered && recovered.id === id) {
      lead = { ...recovered, status: 'lead' };
      leads.push(lead);
      writeLeads(leads);
    }
  }
  return lead;
}

function updateLead(id, patch, fallbackLead = null) {
  const leads = readLeads();
  let lead = leads.find((l) => l.id === id);
  if (!lead && fallbackLead && fallbackLead.id === id) {
    lead = fallbackLead;
    leads.push(lead);
  }
  if (!lead) return null;
  Object.assign(lead, patch, { updatedAt: new Date().toISOString() });
  writeLeads(leads);
  forwardLead(lead);
  return lead;
}

function forwardLead(lead) {
  if (!LEADS_WEBHOOK_URL) return;
  fetch(LEADS_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(lead) })
    .catch((e) => console.error('Lead webhook failed:', e.message));
}

function send(res, status, body, headers = {}) {
  let content = body;
  let isJson = true;
  if (typeof body === 'string') {
    if (status >= 400) {
      content = JSON.stringify({ error: body });
    } else {
      isJson = false;
    }
  } else if (typeof body === 'object' && !Buffer.isBuffer(body)) {
    content = JSON.stringify(body);
  } else {
    isJson = false;
  }
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(content);
}

function readBody(req) {
  if (req.body) {
    if (typeof req.body === 'object' && req.body !== null) return Promise.resolve(req.body);
    if (typeof req.body === 'string') {
      try { return Promise.resolve(JSON.parse(req.body)); } catch {
        return Promise.resolve(Object.fromEntries(new URLSearchParams(req.body)));
      }
    }
  }
  if (req.readableEnded) {
    return Promise.resolve({});
  }
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e5) { reject(new Error('Body too large')); req.destroy(); } });
    req.on('end', () => {
      const type = req.headers['content-type'] || '';
      try {
        if (type.includes('application/json')) resolve(data ? JSON.parse(data) : {});
        else resolve(Object.fromEntries(new URLSearchParams(data)));
      } catch { reject(new Error('Invalid body')); }
    });
    req.on('error', reject);
  });
}

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);

const hits = new Map();
function rateLimited(ip, limit = 30, windowMs = 10 * 60 * 1000) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > limit;
}

function verifySignature(orderId, paymentId, signature) {
  if (!orderId || !paymentId || !signature || !KEY_SECRET) return false;
  const expected = crypto.createHmac('sha256', KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function createOrder(lead) {
  const product = PRODUCTS[lead.product];
  const resp = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64') },
    body: JSON.stringify({
      amount: product.amount, currency: 'INR', receipt: lead.id,
      notes: { lead_id: lead.id, product: lead.product, name: lead.name, mobile: lead.mobile },
    }),
  });
  const json = await resp.json();
  if (!resp.ok) throw new Error(json?.error?.description || 'Razorpay order failed');
  return json;
}

function isAdmin(req) {
  if (!ADMIN_PASSWORD) return false;
  const given = String(req.headers['x-admin-password'] || '');
  const a = Buffer.from(given), b = Buffer.from(ADMIN_PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function toCsv(leads) {
  const cols = ['createdAt', 'product', 'intent', 'status', 'name', 'mobile', 'address', 'dob', 'amount', 'orderId', 'paymentId', 'updatedAt', 'id'];
  const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.join(','), ...leads.map((l) => cols.map((c) => esc(l[c])).join(','))].join('\n');
}

async function handleApi(req, res, url) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

  if (req.method === 'GET' && url.pathname === '/api/config') {
    return send(res, 200, { keyId: KEY_ID, products: Object.fromEntries(Object.entries(PRODUCTS).map(([k, p]) => [k, { amount: p.amount, name: p.name }])) });
  }

  if (req.method === 'POST' && url.pathname === '/api/lead') {
    if (rateLimited(ip)) return send(res, 429, { error: 'Too many requests. Please try again later.' });
    const b = await readBody(req);
    const product = clean(b.product, 20);
    if (!PRODUCTS[product]) return send(res, 400, { error: 'Unknown product' });
    const lead = {
      id: crypto.randomUUID(),
      product,
      intent: b.intent === 'details' ? 'details' : 'pay',
      name: clean(b.name, 80),
      address: clean(b.address, 300),
      mobile: clean(b.mobile, 15).replace(/\D/g, '').replace(/^(91|0)(?=\d{10}$)/, ''),
      dob: product === 'membership' ? clean(b.dob, 10) : '',
      amount: PRODUCTS[product].amount / 100,
      status: 'lead',
      source: clean(b.source, 300),
      userAgent: clean(req.headers['user-agent'], 300),
      createdAt: new Date().toISOString(),
    };
    if (lead.name.length < 2) return send(res, 400, { error: 'Please enter your name' });
    if (lead.address.length < 5) return send(res, 400, { error: 'Please enter your address' });
    if (!/^[6-9]\d{9}$/.test(lead.mobile)) return send(res, 400, { error: 'Please enter a valid 10-digit mobile number' });
    if (product === 'membership' && !/^\d{4}-\d{2}-\d{2}$/.test(lead.dob)) return send(res, 400, { error: 'Please enter your date of birth' });
    const leads = readLeads();
    leads.push(lead);
    writeLeads(leads);
    forwardLead(lead);
    return send(res, 200, { leadId: lead.id, leadToken: createLeadToken(lead) });
  }

  if (req.method === 'POST' && url.pathname === '/api/order') {
    if (rateLimited(ip)) return send(res, 429, { error: 'Too many requests. Please try again later.' });
    const b = await readBody(req);
    const lead = findOrRecoverLead(b.leadId, b.leadToken);
    if (!lead) return send(res, 404, { error: 'Lead not found' });
    if (!KEY_ID || !KEY_SECRET) return send(res, 500, { error: 'Payment gateway not configured' });
    const order = await createOrder(lead);
    updateLead(lead.id, { orderId: order.id, status: 'checkout_started' }, lead);
    const p = PRODUCTS[lead.product];
    return send(res, 200, {
      keyId: KEY_ID, orderId: order.id, amount: order.amount, currency: order.currency,
      name: p.name, description: p.description, prefill: { name: lead.name, contact: '+91' + lead.mobile },
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/verify') {
    const b = await readBody(req);
    const lead = findOrRecoverLead(b.leadId, b.leadToken);
    if (!lead) return send(res, 404, { error: 'Lead not found' });
    const orderMatches = !lead.orderId || b.razorpay_order_id === lead.orderId;
    const ok = orderMatches && verifySignature(b.razorpay_order_id, b.razorpay_payment_id, b.razorpay_signature);
    if (!ok) {
      if (lead.status === 'paid') return send(res, 200, { ok: true, product: lead.product });
      updateLead(lead.id, { status: 'verification_failed' }, lead);
      return send(res, 400, { error: 'Payment verification failed' });
    }
    updateLead(lead.id, { status: 'paid', orderId: b.razorpay_order_id, paymentId: b.razorpay_payment_id, paidAt: new Date().toISOString() }, lead);
    return send(res, 200, { ok: true, product: lead.product });
  }

  // Redirect-mode callback (used inside in-app browsers like Instagram / Facebook on iOS & Android).
  if (req.method === 'POST' && url.pathname === '/api/razorpay/callback') {
    const b = await readBody(req);
    const leadId = url.searchParams.get('lead') || b.leadId;
    const leadToken = url.searchParams.get('token') || b.leadToken;
    const lead = findOrRecoverLead(leadId, leadToken);
    const product = lead ? lead.product : (url.searchParams.get('product') || 'membership');
    let status = 'failed';
    const orderMatches = !lead || !lead.orderId || b.razorpay_order_id === lead.orderId;
    if (lead && b.razorpay_payment_id && orderMatches && verifySignature(b.razorpay_order_id, b.razorpay_payment_id, b.razorpay_signature)) {
      updateLead(lead.id, { status: 'paid', orderId: b.razorpay_order_id, paymentId: b.razorpay_payment_id, paidAt: new Date().toISOString() }, lead);
      status = 'success';
    } else if (lead && lead.status === 'paid') {
      status = 'success';
    } else if (lead) {
      updateLead(lead.id, { status: 'payment_failed', failureReason: clean(b['error[description]'] || b.error_description, 200) }, lead);
    }
    res.writeHead(303, { Location: `/thank-you.html?product=${product}&status=${status}` });
    return res.end();
  }

  if (req.method === 'POST' && url.pathname === '/api/checkout-event') {
    const b = await readBody(req);
    const lead = findOrRecoverLead(b.leadId, b.leadToken);
    if (lead && lead.status !== 'paid') {
      const event = b.event === 'failed' ? 'payment_failed' : 'checkout_dismissed';
      updateLead(lead.id, { status: event, failureReason: clean(b.reason, 200) }, lead);
    }
    return send(res, 200, { ok: true });
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/leads') {
    if (!isAdmin(req)) return send(res, 401, { error: 'Unauthorized' });
    let leads = readLeads();
    const kvLeads = await fetchLeadsFromKv();
    if (kvLeads && Array.isArray(kvLeads)) {
      const map = new Map();
      for (const l of leads) map.set(l.id, l);
      for (const l of kvLeads) map.set(l.id, l);
      leads = Array.from(map.values());
      leads.sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
    }
    const reversed = leads.slice().reverse();
    if (url.searchParams.get('format') === 'csv') {
      return send(res, 200, toCsv(reversed), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="haarivedon-leads.csv"' });
    }
    return send(res, 200, { leads: reversed });
  }

  return send(res, 404, { error: 'Not found' });
}

function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found');
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
    });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const host = req.headers.host || 'localhost';
  const rawUrl = req.headers['x-matched-path'] || req.headers['x-forwarded-uri'] || req.url || '/';
  const resolvedUrl = rawUrl.startsWith('/api/') ? rawUrl : req.url;
  const url = new URL(resolvedUrl, `http://${host}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    return serveStatic(req, res, url);
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: e.message || 'Server error' });
  }
});

if (require.main === module || !process.env.VERCEL) {
  server.listen(PORT, () => console.log(`Haarivedon landing page running on http://localhost:${PORT}`));
}

module.exports = server;
