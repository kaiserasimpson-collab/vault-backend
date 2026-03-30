const express = require('express');
const cors = require('cors');
const { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } = require('plaid');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ─── Plaid setup ─────────────────────────────────────────────────────────────
const plaidConfig = new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV || 'sandbox'],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET': process.env.PLAID_SECRET,
    },
  },
});
const plaidClient = new PlaidApi(plaidConfig);
const userTokens = {};

// ─── Alpha Vantage cache ──────────────────────────────────────────────────────
const stockCache = {};

async function fetchLivePrice(ticker) {
  const now = Date.now();
  if (stockCache[ticker] && now - stockCache[ticker].ts < 60000) {
    return stockCache[ticker].data;
  }
  try {
    const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(ticker)}&apikey=${process.env.ALPHA_VANTAGE_KEY}`;
    const r = await fetch(url);
    const d = await r.json();
    const q = d['Global Quote'];
    if (!q || !q['05. price']) return null;
    const data = {
      ticker,
      price: parseFloat(q['05. price']),
      prevClose: parseFloat(q['08. previous close']),
      change: parseFloat(q['09. change']),
      changePct: q['10. change percent']?.replace('%', '') || '0',
      high: parseFloat(q['03. high']),
      low: parseFloat(q['04. low']),
      volume: parseInt(q['06. volume']),
      lastUpdated: new Date().toISOString(),
    };
    stockCache[ticker] = { ts: now, data };
    return data;
  } catch (e) {
    console.error('Alpha Vantage error for', ticker, e.message);
    return null;
  }
}

// ─── Plaid: link token ────────────────────────────────────────────────────────
app.post('/api/create-link-token', async (req, res) => {
  try {
    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: 'vault-user-1' },
      client_name: 'Vault',
      products: [Products.Transactions, Products.Auth, Products.Liabilities, Products.Investments],
      country_codes: [CountryCode.Us],
      language: 'en',
    });
    res.json({ link_token: response.data.link_token });
  } catch (err) {
    console.error('create-link-token error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error_message || err.message });
  }
});

// ─── Plaid: exchange token ────────────────────────────────────────────────────
app.post('/api/exchange-token', async (req, res) => {
  try {
    const { public_token, institution } = req.body;
    const response = await plaidClient.itemPublicTokenExchange({ public_token });
    userTokens[response.data.item_id] = { accessToken: response.data.access_token, institution };
    res.json({ success: true, itemId: response.data.item_id, institution });
  } catch (err) {
    console.error('exchange-token error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error_message || err.message });
  }
});

// ─── Plaid: accounts ──────────────────────────────────────────────────────────
app.get('/api/accounts', async (req, res) => {
  try {
    const allAccounts = [];
    for (const [itemId, { accessToken, institution }] of Object.entries(userTokens)) {
      try {
        const response = await plaidClient.accountsGet({ access_token: accessToken });
        allAccounts.push(...response.data.accounts.map(a => ({
          id: a.account_id, name: a.name, officialName: a.official_name,
          type: a.type, subtype: a.subtype,
          balance: a.balances.current, available: a.balances.available, limit: a.balances.limit,
          institution: institution?.name || 'Bank', itemId,
        })));
      } catch (e) { console.error('accounts error', itemId, e.message); }
    }
    res.json({ accounts: allAccounts });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Plaid: transactions ──────────────────────────────────────────────────────
app.get('/api/transactions', async (req, res) => {
  try {
    const allTransactions = [];
    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    for (const [itemId, { accessToken, institution }] of Object.entries(userTokens)) {
      try {
        const response = await plaidClient.transactionsGet({
          access_token: accessToken, start_date: startDate, end_date: endDate, options: { count: 50 },
        });
        allTransactions.push(...response.data.transactions.map(t => ({
          id: t.transaction_id, name: t.merchant_name || t.name,
          amount: Math.abs(t.amount),
          category: t.personal_finance_category?.primary || t.category?.[0] || 'Other',
          date: t.date, institution: institution?.name || 'Bank', pending: t.pending,
        })));
      } catch (e) { console.error('transactions error', itemId, e.message); }
    }
    allTransactions.sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json({ transactions: allTransactions });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Plaid: investments (with live AV prices overlaid) ───────────────────────
app.get('/api/investments', async (req, res) => {
  try {
    const allHoldings = [];
    for (const [itemId, { accessToken, institution }] of Object.entries(userTokens)) {
      try {
        const response = await plaidClient.investmentsHoldingsGet({ access_token: accessToken });
        const securities = response.data.securities.reduce((map, s) => { map[s.security_id] = s; return map; }, {});
        allHoldings.push(...response.data.holdings.map(h => {
          const sec = securities[h.security_id] || {};
          return {
            ticker: sec.ticker_symbol || sec.name || 'Unknown', name: sec.name,
            shares: h.quantity, value: h.institution_value, costBasis: h.cost_basis,
            gain: h.institution_value - (h.cost_basis || h.institution_value),
            price: h.institution_price, prevClose: h.institution_price,
            institution: institution?.name || 'Broker',
          };
        }));
      } catch (e) { console.error('investments error', itemId, e.message); }
    }

    // Overlay live AV prices for tickers we recognise
    if (process.env.ALPHA_VANTAGE_KEY) {
      for (const holding of allHoldings) {
        if (holding.ticker && holding.ticker.length <= 5 && /^[A-Z]+$/.test(holding.ticker)) {
          const live = await fetchLivePrice(holding.ticker);
          if (live) {
            holding.prevClose = live.prevClose;
            holding.price = live.price;
            holding.change = live.change;
            holding.changePct = live.changePct;
            holding.value = live.price * holding.shares;
            holding.gain = holding.value - (holding.costBasis || holding.value);
            holding.livePrice = true;
          }
          await new Promise(r => setTimeout(r, 1200));
        }
      }
    }

    res.json({ holdings: allHoldings });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Plaid: liabilities ───────────────────────────────────────────────────────
app.get('/api/liabilities', async (req, res) => {
  try {
    const all = { credit: [], student: [], mortgage: [] };
    for (const [itemId, { accessToken }] of Object.entries(userTokens)) {
      try {
        const r = await plaidClient.liabilitiesGet({ access_token: accessToken });
        const l = r.data.liabilities;
        if (l.credit) all.credit.push(...l.credit);
        if (l.student) all.student.push(...l.student);
        if (l.mortgage) all.mortgage.push(...l.mortgage);
      } catch (e) { console.error('liabilities error', itemId, e.message); }
    }
    res.json(all);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Alpha Vantage: single stock ─────────────────────────────────────────────
app.get('/api/stocks/:ticker', async (req, res) => {
  if (!process.env.ALPHA_VANTAGE_KEY) return res.status(500).json({ error: 'ALPHA_VANTAGE_KEY not set' });
  const data = await fetchLivePrice(req.params.ticker.toUpperCase());
  if (!data) return res.status(404).json({ error: `Could not fetch ${req.params.ticker}` });
  res.json(data);
});

// ─── Alpha Vantage: batch stocks ─────────────────────────────────────────────
app.post('/api/stocks/batch', async (req, res) => {
  const { tickers } = req.body;
  if (!tickers?.length) return res.json({ prices: {} });
  const prices = {};
  for (const ticker of tickers) {
    const data = await fetchLivePrice(ticker.toUpperCase());
    if (data) prices[ticker.toUpperCase()] = data;
    await new Promise(r => setTimeout(r, 1200));
  }
  res.json({ prices, updatedAt: new Date().toISOString() });
});

// ─── AI Credit Score Estimator ───────────────────────────────────────────────
app.post('/api/credit-score', async (req, res) => {
  try {
    const allAccounts = [];
    const allTransactions = [];
    const liabilities = { credit: [], student: [], mortgage: [] };

    for (const [itemId, { accessToken }] of Object.entries(userTokens)) {
      try {
        const r = await plaidClient.accountsGet({ access_token: accessToken });
        allAccounts.push(...r.data.accounts);
      } catch (e) {}
      try {
        const end = new Date().toISOString().split('T')[0];
        const start = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        const r = await plaidClient.transactionsGet({ access_token: accessToken, start_date: start, end_date: end, options: { count: 100 } });
        allTransactions.push(...r.data.transactions);
      } catch (e) {}
      try {
        const r = await plaidClient.liabilitiesGet({ access_token: accessToken });
        const l = r.data.liabilities;
        if (l.credit) liabilities.credit.push(...l.credit);
        if (l.student) liabilities.student.push(...l.student);
        if (l.mortgage) liabilities.mortgage.push(...l.mortgage);
      } catch (e) {}
    }

    const creditAccounts = allAccounts.filter(a => a.type === 'credit');
    const depositAccounts = allAccounts.filter(a => a.type === 'depository');
    const totalCreditLimit = creditAccounts.reduce((s, a) => s + (a.balances.limit || 0), 0);
    const totalCreditBalance = creditAccounts.reduce((s, a) => s + (a.balances.current || 0), 0);
    const utilizationRate = totalCreditLimit > 0 ? Math.round((totalCreditBalance / totalCreditLimit) * 100) : null;
    const totalAssets = depositAccounts.reduce((s, a) => s + (a.balances.current || 0), 0);
    const totalDebt = allAccounts.filter(a => ['credit', 'loan'].includes(a.type)).reduce((s, a) => s + (a.balances.current || 0), 0);
    const monthlyIncome = allTransactions.filter(t => t.amount < 0).reduce((s, t) => s + Math.abs(t.amount), 0) / 3;
    const monthlySpend = allTransactions.filter(t => t.amount > 0).reduce((s, t) => s + t.amount, 0) / 3;

    const profile = {
      totalAccounts: allAccounts.length,
      creditAccounts: creditAccounts.length,
      totalCreditLimit: Math.round(totalCreditLimit),
      totalCreditBalance: Math.round(totalCreditBalance),
      utilizationRate: utilizationRate ?? 'unknown',
      totalAssets: Math.round(totalAssets),
      totalDebt: Math.round(totalDebt),
      monthlyIncome: Math.round(monthlyIncome),
      monthlySpend: Math.round(monthlySpend),
      debtToIncomeRatio: monthlyIncome > 0 ? Math.round((totalDebt / (monthlyIncome * 12)) * 100) : 'unknown',
      creditCardCount: liabilities.credit.length,
      studentLoanCount: liabilities.student.length,
      mortgageCount: liabilities.mortgage.length,
    };

    const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: `You are a credit analyst. Estimate a VantageScore range and analysis from Plaid financial data. Respond ONLY with valid JSON, no markdown, no text outside the JSON.

Return exactly:
{
  "scoreMin": number between 300-850,
  "scoreMax": number between 300-850,
  "rating": "Exceptional" | "Very Good" | "Good" | "Fair" | "Poor",
  "factors": [
    { "name": "string", "impact": "positive" | "negative" | "neutral", "detail": "one sentence" }
  ],
  "summary": "2-3 sentence plain English summary of credit health",
  "tips": ["actionable tip 1", "actionable tip 2", "actionable tip 3"]
}`,
        messages: [{ role: 'user', content: `Estimate credit score for: ${JSON.stringify(profile)}` }],
      }),
    });

    const aiData = await aiResp.json();
    const raw = aiData.content?.map(c => c.text || '').join('') || '{}';
    const scoreData = JSON.parse(raw.replace(/```json|```/g, '').trim());
    res.json({ ...scoreData, profile, generatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('credit-score error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Net worth ────────────────────────────────────────────────────────────────
app.get('/api/net-worth', async (req, res) => {
  try {
    let assets = 0, liabilities = 0;
    for (const [, { accessToken }] of Object.entries(userTokens)) {
      try {
        const r = await plaidClient.accountsGet({ access_token: accessToken });
        for (const a of r.data.accounts) {
          if (['depository', 'investment'].includes(a.type)) assets += a.balances.current || 0;
          if (['credit', 'loan'].includes(a.type)) liabilities += a.balances.current || 0;
        }
      } catch (e) {}
    }
    res.json({ assets: Math.round(assets), liabilities: Math.round(liabilities), netWorth: Math.round(assets - liabilities) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Vault backend running on port ${PORT}`));
