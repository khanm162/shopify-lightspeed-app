const axios = require("axios");
const { Redis } = require('@upstash/redis');

const API_BASE = "https://api.lightspeedapp.com";
const TOKEN_URL = "https://cloud.lightspeedapp.com/auth/oauth/token";
const ACCOUNT_ID = process.env.LIGHTSPEED_ACCOUNT_ID;

// Initialize Redis client
let redis = null;
let redisAvailable = false;

try {
  redis = new Redis({
    url: process.env.KV_REST_API_URL || process.env.REDIS_URL || process.env.KV_URL,
    token: process.env.KV_REST_API_TOKEN || process.env.KV_REST_API_READ_ONLY_TOKEN,
  });

  // Quick non-blocking ping test
  redis.ping()
    .then(() => {
      redisAvailable = true;
      console.log("✅ Upstash Redis connected successfully");
    })
    .catch(err => {
      console.error("❌ Failed to connect to Upstash Redis:", err.message);
      console.warn("Continuing without persistent tokens (in-memory fallback)");
    });
} catch (err) {
  console.error("❌ Redis initialization failed:", err.message);
  console.warn("Continuing without Redis - tokens will be in-memory only");
}

let accessToken = null;
let refreshToken = null;

/* =========================
   OAUTH & Refresh
========================= */

async function exchangeCodeForToken(code) {
  console.log("[AUTH] Exchanging code for tokens...");
  try {
    const res = await axios.post(
      TOKEN_URL,
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: process.env.LIGHTSPEED_CLIENT_ID,
        client_secret: process.env.LIGHTSPEED_CLIENT_SECRET,
        redirect_uri: process.env.LIGHTSPEED_REDIRECT_URI
      }).toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    accessToken = res.data.access_token;
    refreshToken = res.data.refresh_token;

    console.log("[AUTH] Tokens received - accessToken length:", accessToken?.length || 0);
    console.log("[AUTH] Refresh token length:", refreshToken?.length || "MISSING!");

    if (redisAvailable) {
  const payload = JSON.stringify({ accessToken, refreshToken });
  await redis.set('lightspeed_tokens', payload);
  console.log("[AUTH] Tokens saved to Redis - payload length:", payload.length);

  // Safe verification
  const verify = await redis.get('lightspeed_tokens');
  if (verify && typeof verify === 'string') {
    console.log("[AUTH] Verification read back: OK");
    console.log("[AUTH] Saved value preview:", verify.substring(0, 200) + "...");
  } else {
    console.log("[AUTH] Verification read back: FAILED - value:", verify);
  }
} else {
  console.warn("[AUTH] Redis unavailable - tokens only in memory");
}

    return accessToken;
  } catch (err) {
    console.error("[AUTH] Exchange failed:", err.message);
    if (err.response) {
      console.error("Status:", err.response.status);
      console.error("Response:", JSON.stringify(err.response.data, null, 2));
    }
    throw err;
  }
}

async function refreshAccessToken() {
  console.log("[REFRESH] Starting... Current refreshToken:", refreshToken ? "present (len:" + refreshToken.length + ")" : "missing");

  if (!refreshToken) {
    await loadTokens();
    console.log("[REFRESH] After load - refreshToken:", refreshToken ? "present (len:" + refreshToken.length + ")" : "still missing");
    if (!refreshToken) {
      throw new Error("No refresh token available - re-authenticate required");
    }
  }

  try {
    console.log("[REFRESH] Calling Lightspeed refresh API...");
    const res = await axios.post(
      TOKEN_URL,
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: process.env.LIGHTSPEED_CLIENT_ID,
        client_secret: process.env.LIGHTSPEED_CLIENT_SECRET
      }).toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    accessToken = res.data.access_token;
    refreshToken = res.data.refresh_token || refreshToken; // Keep old if not returned

    console.log("[REFRESH] New accessToken received - length:", accessToken.length);

    if (redisAvailable) {
      const payload = JSON.stringify({ accessToken, refreshToken });
      await redis.set('lightspeed_tokens', payload);
      console.log("[REFRESH] New tokens saved to Redis");
      // Verify
      const verify = await redis.get('lightspeed_tokens');
      console.log("[REFRESH] Verification read back:", verify ? "OK" : "FAILED");
    }

    return accessToken;
  } catch (err) {
    console.error("[REFRESH] API refresh failed:", err.message);
    if (err.response) {
      console.error("Status:", err.response.status);
      console.error("Response:", JSON.stringify(err.response.data, null, 2));
    }
    throw err;
  }
}

async function loadTokens() {
  if (!redisAvailable) {
    console.warn("[LOAD] Redis not available - skipping token load");
    return;
  }

  const saved = await redis.get('lightspeed_tokens');
  console.log("[LOAD] Raw Redis value for lightspeed_tokens:", saved || "null/empty");

  if (saved) {
    try {
      const tokens = JSON.parse(saved);
      if (tokens?.accessToken && tokens?.refreshToken) {
        accessToken = tokens.accessToken;
        refreshToken = tokens.refreshToken;
        console.log("[LOAD] Success - tokens loaded from Redis");
        console.log("[LOAD] Access token length:", accessToken.length);
        console.log("[LOAD] Refresh token length:", refreshToken.length);
      } else {
        console.warn("[LOAD] Invalid token structure - deleting key");
        await redis.del('lightspeed_tokens');
      }
    } catch (err) {
      console.error("[LOAD] Parse error:", err.message);
      console.warn("[LOAD] Deleting corrupted key");
      await redis.del('lightspeed_tokens');
    }
  } else {
    console.warn("[LOAD] No tokens in Redis - re-auth required");
  }
}

loadTokens(); // Load on startup

function authHeader() {
  if (!accessToken) throw new Error("Lightspeed token missing");
  return { Authorization: `Bearer ${accessToken}` };
}

function hasValidToken() {
  return !!accessToken;
}

/* =========================
   ITEMS & SALES
========================= */

async function getItemBySystemSku(systemSku) {
  if (!systemSku) throw new Error("No SKU provided for item lookup");
  const trimmedSku = String(systemSku).trim();
  console.log(`🔍 Looking up Lightspeed item by systemSku: "${trimmedSku}"`);

  try {
    const res = await axios.get(
      `${API_BASE}/API/Account/${ACCOUNT_ID}/Item.json`,
      { headers: authHeader(), params: { systemSku: trimmedSku } }
    );

    let item = res.data.Item;
    if (Array.isArray(item)) item = item[0];

    if (!item || !item.itemID) {
      throw new Error(`Item not found for systemSku: ${trimmedSku}`);
    }

    console.log(`✅ Found itemID: ${item.itemID} (description: ${item.description})`);
    return item;
  } catch (err) {
    if (err.response?.status === 401) {
      console.log("[ITEM] Token expired - refreshing...");
      await refreshAccessToken();
      return getItemBySystemSku(systemSku); // Retry
    }
    console.error("Item lookup failed:", err.message);
    throw err;
  }
}

async function createSale({ saleLines, customerID }) {
  if (!customerID) throw new Error("Customer ID required");
  const EMPLOYEE_ID = Number(process.env.LIGHTSPEED_EMPLOYEE_ID);
  console.log(`Creating sale for Lightspeed customer: ${customerID}`);

  const formattedLines = [];
  for (const line of saleLines) {
    const itemRes = await axios.get(
      `${API_BASE}/API/Account/${ACCOUNT_ID}/Item/${line.itemID}.json`,
      { headers: authHeader() }
    );
    const item = itemRes.data.Item;
    const avgCost = parseFloat(item.avgCost || item.defaultCost || 0);
    let fulfillmentPrice = avgCost / 0.80;
    fulfillmentPrice = parseFloat(fulfillmentPrice.toFixed(2));

    if (isNaN(fulfillmentPrice) || fulfillmentPrice <= 0) {
      console.warn(`Warning: Invalid avgCost for item ${line.itemID} - using original price`);
      fulfillmentPrice = line.unitPrice;
    }

    console.log(`Item ${line.itemID}: avgCost $${avgCost.toFixed(2)} → Fulfillment Price $${fulfillmentPrice.toFixed(2)}`);

    formattedLines.push({
      itemID: line.itemID,
      unitQuantity: line.quantity,
      unitPrice: fulfillmentPrice
    });
  }

  const subtotal = formattedLines.reduce((sum, l) => sum + (l.unitPrice * l.unitQuantity), 0);
  const taxRate = 0.07;
  const totalWithTax = (subtotal * (1 + taxRate)).toFixed(2);

  const payload = {
    customerID: Number(customerID),
    employeeID: EMPLOYEE_ID,
    registerID: Number(process.env.LIGHTSPEED_REGISTER_ID),
    shopID: Number(process.env.LIGHTSPEED_SHOP_ID),
    completed: true,
    enablePromotions: false,
    taxCategoryID: 3,
    SaleLines: { SaleLine: formattedLines },
    SalePayments: {
      SalePayment: [{
        paymentTypeID: 17,
        amount: totalWithTax
      }]
    }
  };

  console.log("Sending sale payload:", JSON.stringify(payload, null, 2));

  try {
    const res = await axios.post(
      `${API_BASE}/API/Account/${ACCOUNT_ID}/Sale.json`,
      payload,
      { headers: authHeader() }
    );

    console.log(`🎉 Sale synced: Sale ID ${res.data.Sale.saleID} - Total: $${totalWithTax}`);
    return res.data.Sale;
  } catch (err) {
    if (err.response?.status === 401) {
      console.log("[SALE] Token expired - refreshing...");
      await refreshAccessToken();
      return createSale({ saleLines, customerID }); // Retry
    }
    console.error("Sale creation failed:", err.message);
    throw err;
  }
}

/* EXPORTS */
module.exports = {
  exchangeCodeForToken,
  refreshAccessToken,
  hasValidToken,
  getItemBySystemSku,
  createSale
};