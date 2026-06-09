const express = require('express');
const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const POSTBACK_TOKEN = process.env.POSTBACK_TOKEN || 'cashflix_secure_2026';

const offerConfig = {
  'Coinswitch': {
    e1Amt: 0,       e1Balance: false, e1Comment: 'Coinswitch Install',
    e2Amt: 25,      e2Balance: true,  e2Comment: 'Coinswitch Trial',
    e3Amt: 0,       e3Balance: false, e3Comment: 'Coinswitch Step 3',
    e4Amt: 0,       e4Balance: false, e4Comment: 'Coinswitch Step 4',
    referAmt: 50
  }
};

const rateLimitMap = {};
function rateLimit(ip, limit = 50, windowMs = 60000) {
  const now = Date.now();
  if (!rateLimitMap[ip]) rateLimitMap[ip] = [];
  rateLimitMap[ip] = rateLimitMap[ip].filter(t => now - t < windowMs);
  if (rateLimitMap[ip].length >= limit) return false;
  rateLimitMap[ip].push(now);
  return true;
}

async function fetchWithTimeout(url, options = {}, timeout = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

function maskUPI(upi) {
  if (!upi || !upi.includes('@')) return upi;
  const [user, bank] = upi.split('@');
  return user.slice(0, 4) + '****' + bank;
}

function getTime() {
  return new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }).replace(',', '');
}

function sanitize(text) {
  if (!text) return '';
  return String(text).replace(/[<>]/g, '').trim().slice(0, 500);
}

function generateReferCode(upi) {
  return upi.replace(/[^a-zA-Z0-9]/g, '').slice(0, 6).toUpperCase() + Math.floor(100 + Math.random() * 900);
}

function getEventConfig(config, eventName) {
  const e1Events = ['web', 'initial', 'install', 'e1', 'default'];
  const e2Events = ['trial', 'purchase', 'e2', 'complete', 'signup', 'goldbuy', 'sign_up_success', 'af_complete_registration', 'gold_silver_successful_purchase'];
  const e3Events = ['e3', 'step3', 'kyc', 'verify'];
  const e4Events = ['e4', 'step4', 'deposit', 'buy', 'trade'];

  if (e1Events.includes(eventName)) return { amt: config.e1Amt, balance: config.e1Balance, comment: config.e1Comment, type: 'install' };
  if (e2Events.includes(eventName)) return { amt: config.e2Amt, balance: config.e2Balance, comment: config.e2Comment, type: 'trial' };
  if (e3Events.includes(eventName)) return { amt: config.e3Amt, balance: config.e3Balance, comment: config.e3Comment, type: 'e3' };
  if (e4Events.includes(eventName)) return { amt: config.e4Amt, balance: config.e4Balance, comment: config.e4Comment, type: 'e4' };
  return null;
}

async function sendMsg(chat_id, text) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetchWithTimeout(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id, text, parse_mode: 'HTML' })
      });
      if (res.ok) break;
    } catch(e) {
      if (i === 2) console.error('sendMsg failed:', e);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

async function dbGet(table, filter) {
  const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
  });
  return res.json();
}

async function dbPost(table, data) {
  await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
    body: JSON.stringify(data)
  });
}

async function dbPatch(table, filter, data) {
  await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method: 'PATCH',
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
}

// ✅ Register endpoint
app.post('/register', async (req, res) => {
  try {
    const { upi_id, offer_name, refer_code } = req.body;
    if (!upi_id || !offer_name) return res.json({ success: false, error: 'Missing fields' });

    const existing = await dbGet('upi_users', `upi_id=eq.${encodeURIComponent(upi_id)}`);
    if (existing.length > 0) {
      return res.json({ success: true, refer_code: existing[0].refer_code, already: true });
    }

    let referred_by = null;
    if (refer_code) {
      const referrer = await dbGet('upi_users', `refer_code=eq.${refer_code}`);
      if (referrer.length > 0) referred_by = referrer[0].upi_id;
    }

    const newReferCode = generateReferCode(upi_id);
    const masked = maskUPI(upi_id);

    await dbPost('upi_users', {
      upi_id,
      masked_upi: masked,
      refer_code: newReferCode,
      referred_by,
      total_earnings: 0
    });

    await dbPost('clicks', { click_id: upi_id, offer_name: sanitize(offer_name) });

    res.json({ success: true, refer_code: newReferCode });
  } catch(e) {
    console.error(e);
    res.json({ success: false });
  }
});

// ✅ Tracker endpoint
app.get('/tracker', async (req, res) => {
  try {
    const { upi } = req.query;
    if (!upi) return res.json({ success: false });

    const users = await dbGet('upi_users', `upi_id=eq.${encodeURIComponent(upi)}`);
    if (users.length === 0) return res.json({ success: false, error: 'Not found' });

    const u = users[0];
    const conversions = await dbGet('upi_conversions', `upi_id=eq.${encodeURIComponent(upi)}&order=created_at.desc`);

    res.json({
      success: true,
      upi_id: u.masked_upi,
      total_earnings: u.total_earnings,
      refer_code: u.refer_code,
      conversions: conversions.map(c => ({
        offer_name: c.offer_name,
        event: c.event,
        amount: c.amount,
        status: c.status,
        time: c.created_at
      }))
    });
  } catch(e) {
    console.error(e);
    res.json({ success: false });
  }
});

// ✅ Postback endpoint
app.get('/postback', async (req, res) => {
  try {
    const { click_id = 'N/A', event = 'N/A', token } = req.query;

    if (token !== POSTBACK_TOKEN) {
      console.log('INVALID TOKEN:', token);
      return res.status(403).send('Forbidden');
    }

    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    if (!rateLimit(ip, 50, 60000)) return res.status(429).send('Too Many Requests');

    console.log('POSTBACK RECEIVED:', req.query);

    let offer = req.query.offer || 'Unknown';
    let runTime = getTime();

    try {
      const clicks = await dbGet('clicks', `click_id=eq.${encodeURIComponent(click_id)}&order=created_at.desc&limit=1`);
      if (clicks.length > 0) {
        offer = clicks[0].offer_name;
        runTime = new Date(clicks[0].created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }).replace(',', '');
      }
    } catch(e) {}

    const config = offerConfig[offer] || {
      e1Amt: 0, e1Balance: false, e1Comment: `${offer} Install`,
      e2Amt: 0, e2Balance: false, e2Comment: `${offer} Trial`,
      e3Amt: 0, e3Balance: false, e3Comment: `${offer} Step 3`,
      e4Amt: 0, e4Balance: false, e4Comment: `${offer} Step 4`,
      referAmt: 0
    };

    const eventName = event?.trim().toLowerCase();
    const eventConfig = getEventConfig(config, eventName);
    const trackTime = getTime();

    if (!eventConfig) {
      console.log('UNKNOWN EVENT:', eventName);
      return res.send('OK');
    }

    console.log('EVENT TYPE:', eventConfig.type, 'AMOUNT:', eventConfig.amt);

    // ✅ Install event — sirf track
    if (eventConfig.type === 'install') {
      await dbPost('upi_conversions', { upi_id: click_id, offer_name: offer, event, amount: 0, status: 'tracked' });

      const users = await dbGet('upi_users', `upi_id=eq.${encodeURIComponent(click_id)}`);
      const userStatus = users.length > 0 ? 'Success' : 'Failed';

      const msg = `<b>Conversation Count 💝</b>\n\n<b>🎁 Offer Name - ${offer}</b>\n\n<b>User Id : ${maskUPI(click_id)}</b>\n<b>🥳 Sms Sent : ${userStatus}</b>\n\n<b>Run Time - ${runTime}</b>\n<b>Track Time - ${trackTime}</b>\n\n<b>Powered By - CashFlix</b>`;
      await sendMsg(CHAT_ID, msg);
      return res.send('OK');
    }

    // ✅ Trial/e3/e4 — payout
    const users = await dbGet('upi_users', `upi_id=eq.${encodeURIComponent(click_id)}`);
    const userFound = users.length > 0;
    const u = userFound ? users[0] : null;
    const amt = eventConfig.amt || 0;
    const referAmt = config.referAmt || 0;

    let referFound = false;
    let referUpi = 'N/A';
    let referAmtPaid = 0;

    if (userFound && amt > 0 && eventConfig.balance) {
      const newEarnings = parseFloat(u.total_earnings) + amt;
      await dbPatch('upi_users', `upi_id=eq.${encodeURIComponent(click_id)}`, { total_earnings: newEarnings });
      await dbPost('upi_conversions', { upi_id: click_id, offer_name: offer, event, amount: amt, status: 'paid' });
      await dbPost('upi_payouts', { upi_id: click_id, amount: amt, status: 'pending' });

      // ✅ Refer bonus sirf trial pe
      if (eventConfig.type === 'trial' && u.referred_by && referAmt > 0) {
        referUpi = u.referred_by;
        referFound = true;
        referAmtPaid = referAmt;
        const referrer = await dbGet('upi_users', `upi_id=eq.${encodeURIComponent(u.referred_by)}`);
        if (referrer.length > 0) {
          const newRefEarnings = parseFloat(referrer[0].total_earnings) + referAmt;
          await dbPatch('upi_users', `upi_id=eq.${encodeURIComponent(u.referred_by)}`, { total_earnings: newRefEarnings });
          await dbPost('upi_payouts', { upi_id: u.referred_by, amount: referAmt, status: 'pending' });
        }
      }
    } else if (userFound) {
      await dbPost('upi_conversions', { upi_id: click_id, offer_name: offer, event, amount: amt, status: 'tracked' });
    }

    const userPayment = userFound ? 'Success' : 'Failed';

    const msg = `<b>Conversation Count 💝</b>\n\n<b>🎁 Offer Name - ${offer}</b>\n\n<b>User Id : ${maskUPI(click_id)}</b>\n<b>User Amount : ₹${amt}</b>\n<b>🥳 User Payment : ${userPayment}</b>\n\n<b>Refer Id : ${maskUPI(referUpi)}</b>\n<b>Refer Amount : ₹${referAmtPaid}</b>\n<b>🥳 Refer Payment : Success</b>\n\n<b>Run Time - ${runTime}</b>\n<b>Track Time - ${trackTime}</b>\n\n<b>Powered By - CashFlix</b>`;
    await sendMsg(CHAT_ID, msg);

  } catch(e) {
    console.error(e);
  }
  res.send('OK');
});

// ✅ Click endpoint
app.post('/click', async (req, res) => {
  try {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    if (!rateLimit(ip, 30, 60000)) return res.status(429).json({ success: false });
    const { click_id, offer_name } = req.body;
    if (!click_id || !offer_name) return res.json({ success: false });
    console.log('CLICK RECEIVED:', { click_id, offer_name });
    await dbPost('clicks', { click_id, offer_name: sanitize(offer_name) });
    res.json({ success: true });
  } catch(e) {
    console.error(e);
    res.json({ success: false });
  }
});

app.get('/', (req, res) => res.send('CashFlix UPI System Running! ✅'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on port ${PORT}`));

setInterval(async () => {
  try { await fetchWithTimeout('https://cashflix-upi.onrender.com/'); } catch(e) {}
}, 14 * 60 * 1000);
