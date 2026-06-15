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
    e1Amt: 0, e1Balance: false, e1Comment: 'Coinswitch Install',
    e2Amt: 200, e2Balance: true, e2Comment: 'Coinswitch Trial',
    e3Amt: 0, e3Balance: false, e3Comment: 'Coinswitch Step 3',
    e4Amt: 0, e4Balance: false, e4Comment: 'Coinswitch Step 4',
    referAmt: 50
  }
};

const landingUrls = {
  'Coinswitch': 'https://coinswitch-rho.vercel.app'
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

function generateReferCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function getEventConfig(config, eventName) {
  const e1Events = ['web', 'initial', 'install', 'e1', 'default'];
  const e2Events = ['trial', 'purchase', 'e2', 'complete', 'signup', 'goldbuy', 'sign_up_success', 'af_complete_registration', 'gold_silver_successful_purchase'];
  const e3Events = ['e3', 'step3', 'kyc', 'verify'];
  const e4Events = ['e4', 'step4', 'deposit', 'buy', 'trade'];

  if (e1Events.includes(eventName)) return { amt: config.e1Amt, balance: config.e1Balance, comment: config.e1Comment, type: 'install', label: 'Install' };
  if (e2Events.includes(eventName)) return { amt: config.e2Amt, balance: config.e2Balance, comment: config.e2Comment, type: 'trial', label: 'Trial' };
  if (e3Events.includes(eventName)) return { amt: config.e3Amt, balance: config.e3Balance, comment: config.e3Comment, type: 'e3', label: 'KYC' };
  if (e4Events.includes(eventName)) return { amt: config.e4Amt, balance: config.e4Balance, comment: config.e4Comment, type: 'e4', label: 'Deposit' };
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

// ✅ Click endpoint
app.post('/click', async (req, res) => {
  try {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    if (!rateLimit(ip, 30, 60000)) return res.status(429).json({ success: false });
    const { click_id, offer_name, refer_code } = req.body;
    if (!click_id || !offer_name) return res.json({ success: false });
    console.log('CLICK RECEIVED:', { click_id, offer_name });

    let referred_by = null;
    let user_payout = null;
    let my_payout = null;
    if (refer_code) {
      const referral = await dbGet('referrals', `code=eq.${refer_code}`);
      if (referral.length > 0) {
        referred_by = referral[0].referrer_upi;
        user_payout = referral[0].user_payout;
        my_payout = referral[0].my_payout;
      }
    }

    await dbPost('clicks', {
      click_id,
      offer_name: sanitize(offer_name),
      referred_by,
      user_payout,
      my_payout
    });

    res.json({ success: true });
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

    const conversions = await dbGet('upi_conversions', `upi_id=eq.${encodeURIComponent(upi)}&order=created_at.desc`);
    if (conversions.length === 0) return res.json({ success: false, error: 'Not found' });

    const totalEarnings = conversions.reduce((sum, c) => sum + (c.status === 'paid' ? parseFloat(c.amount) : 0), 0);

    res.json({
      success: true,
      upi_id: maskUPI(upi),
      total_earnings: totalEarnings,
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

// ✅ Refer create endpoint
app.post('/refer/create', async (req, res) => {
  try {
    const { offer_id, offer_name, referrer_upi, user_payout, my_payout } = req.body;
    if (!offer_id || !referrer_upi) return res.json({ success: false });

    const code = generateReferCode();

    await dbPost('referrals', {
      code,
      offer_id,
      offer_name,
      referrer_upi,
      user_payout: user_payout || 0,
      my_payout: my_payout || 0
    });

    const landing_url = landingUrls[offer_id] || `https://cashflix.site/Offer/${offer_id}`;
    res.json({ success: true, code, landing_url });
  } catch(e) {
    console.error(e);
    res.json({ success: false });
  }
});

// ✅ Refer amount check endpoint
app.get('/refer/amount', async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.json({ success: false });
    const referral = await dbGet('referrals', `code=eq.${code}`);
    if (referral.length === 0) return res.json({ success: false });
    res.json({ success: true, user_payout: referral[0].user_payout, my_payout: referral[0].my_payout });
  } catch(e) {
    res.json({ success: false });
  }
});

// ✅ Offer status endpoint
app.get('/offer-status', async (req, res) => {
  try {
    const { offer } = req.query;
    if (!offer) return res.json({ is_active: true });
    const result = await dbGet('offer_status', `offer_name=eq.${encodeURIComponent(offer)}`);
    if (result.length > 0) {
      res.json({ is_active: result[0].is_active });
    } else {
      res.json({ is_active: true });
    }
  } catch(e) {
    res.json({ is_active: true });
  }
});

// ✅ Admin chart endpoint — same row mein user + refer details
app.get('/admin/conversions', async (req, res) => {
  try {
    const { token } = req.query;
    if (token !== POSTBACK_TOKEN) return res.status(403).json({ success: false, error: 'Forbidden' });

    const conversions = await dbGet('upi_conversions', `order=created_at.desc&limit=200`);

    res.json({
      success: true,
      conversions: conversions.map(c => ({
        offer_name: c.offer_name,
        event: c.event,
        upi_id: maskUPI(c.upi_id),
        amount: c.amount,
        status: c.status,
        refer_upi: c.refer_upi ? maskUPI(c.refer_upi) : null,
        refer_amount: c.refer_amount || 0,
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
    let referred_by = null;
    let user_payout_custom = null;
    let my_payout_custom = null;

    try {
      const clicks = await dbGet('clicks', `click_id=eq.${encodeURIComponent(click_id)}&order=created_at.desc&limit=1`);
      if (clicks.length > 0) {
        offer = clicks[0].offer_name;
        runTime = new Date(clicks[0].created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }).replace(',', '');
        referred_by = clicks[0].referred_by;
        user_payout_custom = clicks[0].user_payout;
        my_payout_custom = clicks[0].my_payout;
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

    // ✅ Install event
    if (eventConfig.type === 'install') {
      await dbPost('upi_conversions', { upi_id: click_id, offer_name: offer, event, amount: 0, status: 'tracked' });

      const msg = `<b>Conversation Count 💝</b>\n\n<b>🎁 Offer Name - ${offer}</b>\n\n<b>User Id : ${maskUPI(click_id)}</b>\n<b>🥳 Event : ${eventConfig.label} ✅</b>\n\n<b>Run Time - ${runTime}</b>\n<b>Track Time - ${trackTime}</b>\n\n<b>Powered By - CashFlix</b>`;
      await sendMsg(CHAT_ID, msg);
      return res.send('OK');
    }

    // ✅ Trial/e3/e4 — payout, same row mein user + refer dono
    let amt = user_payout_custom || eventConfig.amt || 0;
    let referAmt = my_payout_custom || config.referAmt || 0;

    let referUpi = null;
    let referAmtPaid = 0;
    let convStatus = 'tracked';

    if (amt > 0 && eventConfig.balance) {
      convStatus = 'paid';
      await dbPost('upi_payouts', { upi_id: click_id, amount: amt, status: 'pending' });

      if (referred_by && referAmt > 0) {
        referUpi = referred_by;
        referAmtPaid = referAmt;
        await dbPost('upi_payouts', { upi_id: referred_by, amount: referAmt, status: 'pending' });
      }
    }

    // ✅ Ek hi row mein sab save karo
    await dbPost('upi_conversions', {
      upi_id: click_id,
      offer_name: offer,
      event,
      amount: amt,
      status: convStatus,
      refer_upi: referUpi,
      refer_amount: referAmtPaid
    });

    const msg = `<b>Conversation Count 💝</b>\n\n<b>🎁 Offer Name - ${offer}</b>\n\n<b>User Id : ${maskUPI(click_id)}</b>\n<b>User Amount : ₹${amt}</b>\n<b>🥳 Event : ${eventConfig.label} ✅</b>\n<b>🥳 User Payment : Success</b>\n\n<b>Refer Id : ${maskUPI(referUpi || 'N/A')}</b>\n<b>Refer Amount : ₹${referAmtPaid}</b>\n<b>🥳 Refer Payment : Success</b>\n\n<b>Run Time - ${runTime}</b>\n<b>Track Time - ${trackTime}</b>\n\n<b>Powered By - CashFlix</b>`;
    await sendMsg(CHAT_ID, msg);

  } catch(e) {
    console.error(e);
  }
  res.send('OK');
});

app.get('/', (req, res) => res.send('CashFlix UPI System Running! ✅'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on port ${PORT}`));

setInterval(async () => {
  try { await fetchWithTimeout('https://cashflix-upi.onrender.com/'); } catch(e) {}
}, 14 * 60 * 1000);
