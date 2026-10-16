'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const LEADS_WEBHOOK_URL = process.env.LEADS_WEBHOOK_URL || '';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE = path.join(__dirname, 'data', 'leads.json');

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
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return []; }
}
function writeLeads(leads) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(leads, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}
function updateLead(id, patch) {
  const leads = readLeads();
  const lead = leads.find((l) => l.id === id);
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
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, { 'Content-Type': isObj ? 'application/json' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
}
function readBody(req) {
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
    return send(res, 200, { leadId: lead.id });
  }

  if (req.method === 'POST' && url.pathname === '/api/order') {
    if (rateLimited(ip)) return send(res, 429, { error: 'Too many requests. Please try again later.' });
    const b = await readBody(req);
    const lead = readLeads().find((l) => l.id === b.leadId);
    if (!lead) return send(res, 404, { error: 'Lead not found' });
    if (!KEY_ID || !KEY_SECRET) return send(res, 500, { error: 'Payment gateway not configured' });
    const order = await createOrder(lead);
    updateLead(lead.id, { orderId: order.id, status: 'checkout_started' });
    const p = PRODUCTS[lead.product];
    return send(res, 200, {
      keyId: KEY_ID, orderId: order.id, amount: order.amount, currency: order.currency,
      name: p.name, description: p.description, prefill: { name: lead.name, contact: '+91' + lead.mobile },
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/verify') {
    const b = await readBody(req);
    const lead = readLeads().find((l) => l.id === b.leadId);
    if (!lead) return send(res, 404, { error: 'Lead not found' });
    const ok = b.razorpay_order_id === lead.orderId && verifySignature(b.razorpay_order_id, b.razorpay_payment_id, b.razorpay_signature);
    if (!ok) {
      if (lead.status === 'paid') return send(res, 200, { ok: true, product: lead.product });
      updateLead(lead.id, { status: 'verification_failed' }); return send(res, 400, { error: 'Payment verification failed' });
    }
    updateLead(lead.id, { status: 'paid', paymentId: b.razorpay_payment_id, paidAt: new Date().toISOString() });
    return send(res, 200, { ok: true, product: lead.product });
  }

  // Redirect-mode callback (used inside in-app browsers like Instagram / Facebook on iOS & Android).
  if (req.method === 'POST' && url.pathname === '/api/razorpay/callback') {
    const b = await readBody(req);
    const lead = readLeads().find((l) => l.id === url.searchParams.get('lead'));
    const product = lead ? lead.product : 'membership';
    let status = 'failed';
    if (lead && b.razorpay_payment_id && b.razorpay_order_id === lead.orderId && verifySignature(b.razorpay_order_id, b.razorpay_payment_id, b.razorpay_signature)) {
      updateLead(lead.id, { status: 'paid', paymentId: b.razorpay_payment_id, paidAt: new Date().toISOString() });
      status = 'success';
    } else if (lead && lead.status === 'paid') {
      status = 'success';
    } else if (lead) {
      updateLead(lead.id, { status: 'payment_failed', failureReason: clean(b['error[description]'] || b.error_description, 200) });
    }
    res.writeHead(303, { Location: `/thank-you.html?product=${product}&status=${status}` });
    return res.end();
  }

  if (req.method === 'POST' && url.pathname === '/api/checkout-event') {
    const b = await readBody(req);
    const lead = readLeads().find((l) => l.id === b.leadId);
    if (lead && lead.status !== 'paid') {
      const event = b.event === 'failed' ? 'payment_failed' : 'checkout_dismissed';
      updateLead(lead.id, { status: event, failureReason: clean(b.reason, 200) });
    }
    return send(res, 200, { ok: true });
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/leads') {
    if (!isAdmin(req)) return send(res, 401, { error: 'Unauthorized' });
    const leads = readLeads().slice().reverse();
    if (url.searchParams.get('format') === 'csv') {
      return send(res, 200, toCsv(leads), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="haarivedon-leads.csv"' });
    }
    return send(res, 200, { leads });
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

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    return serveStatic(req, res, url);
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: e.message || 'Server error' });
  }
}).listen(PORT, () => console.log(`Haarivedon landing page running on http://localhost:${PORT}`));
