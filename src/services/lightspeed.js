const axios = require("axios");
const fs = require("fs");

const API_BASE = "https://api.lightspeedapp.com";
const TOKEN_URL = "https://cloud.lightspeedapp.com/auth/oauth/token";
const ACCOUNT_ID = process.env.LIGHTSPEED_ACCOUNT_ID;

const TOKENS_FILE = "./tokens.json"; // Store tokens here - add to .gitignore

let accessToken = null;
let refreshToken = null;

/* =========================
   OAUTH & Refresh
========================= */
async function exchangeCodeForToken(code) {
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
  refreshToken = res.data.refresh_token; // Save this

  saveTokens(); // Save to file

  console.log("✅ Lightspeed access token received");
  return accessToken;
}

async function refreshAccessToken() {
  if (!refreshToken) throw new Error("No refresh token available");

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
  refreshToken = res.data.refresh_token; // Update if new one issued

  saveTokens(); // Save updated tokens

  console.log("✅ Lightspeed access token refreshed");
  return accessToken;
}

function saveTokens() {
  fs.writeFileSync(TOKENS_FILE, JSON.stringify({ accessToken, refreshToken }));
  console.log("Tokens saved to file");
}

function loadTokens() {
  if (fs.existsSync(TOKENS_FILE)) {
    const data = JSON.parse(fs.readFileSync(TOKENS_FILE));
    accessToken = data.accessToken;
    refreshToken = data.refreshToken;
    console.log("Tokens loaded from file");
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

    console.log("API response status:", res.status);

    let item = res.data.Item;

    if (Array.isArray(item)) {
      item = item[0];
    } else if (item && typeof item === 'object' && item.itemID) {
      // good
    } else {
      item = null;
    }

    if (!item || !item.itemID) {
      throw new Error(`Item not found for systemSku: ${trimmedSku}`);
    }

    console.log(`✅ Found itemID: ${item.itemID} (description: ${item.description})`);
    return item;
  } catch (err) {
    if (err.response && err.response.status === 401) {
      await refreshAccessToken();
      return getItemBySystemSku(systemSku); // Retry
    }
    console.error("Item lookup failed:", err.message);
    if (err.response) {
      console.error("Status:", err.response.status);
      console.error("API error data:", JSON.stringify(err.response.data, null, 2));
    }
    throw err;
  }
}

async function createSale({ saleLines, customerID }) {
  if (!customerID) throw new Error("Customer ID required");

  const EMPLOYEE_ID = Number(process.env.LIGHTSPEED_EMPLOYEE_ID);

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
      console.warn(`Invalid avgCost for item ${line.itemID} - using original price`);
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
      SalePayment: [
        {
          paymentTypeID: 17,
          amount: totalWithTax
        }
      ]
    }
  };

  console.log("Sending sale payload:", JSON.stringify(payload, null, 2));

  try {
    const res = await axios.post(
      `${API_BASE}/API/Account/${ACCOUNT_ID}/Sale.json`,
      payload,
      { headers: authHeader() }
    );

    console.log(`🎉 Sale synced: Sale ID ${res.data.Sale.saleID}`);
    return res.data.Sale;
  } catch (err) {
    if (err.response && err.response.status === 401) {
      await refreshAccessToken();
      return createSale({ saleLines, customerID }); // Retry
    }
    console.error("Sale creation failed:", err.message);
    console.error("API error:", JSON.stringify(err.response?.data, null, 2));
    throw err;
  }
}

/* EXPORTS */
module.exports = {
  exchangeCodeForToken,
  hasValidToken,
  getItemBySystemSku,
  createSale
};