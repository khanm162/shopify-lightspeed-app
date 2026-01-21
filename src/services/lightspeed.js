const axios = require("axios");
const { Redis } = require('@upstash/redis');

const API_BASE = "https://api.lightspeedapp.com";
const TOKEN_URL = "https://cloud.lightspeedapp.com/auth/oauth/token";
const ACCOUNT_ID = process.env.LIGHTSPEED_ACCOUNT_ID;

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

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
  refreshToken = res.data.refresh_token;

  await redis.set('lightspeed_tokens', JSON.stringify({ accessToken, refreshToken }));
  console.log("✅ Tokens saved to Upstash Redis");

  return accessToken;
}

async function refreshAccessToken() {
  if (!refreshToken) {
    const saved = await redis.get('lightspeed_tokens');
    if (saved) {
      const tokens = JSON.parse(saved);
      accessToken = tokens.accessToken;
      refreshToken = tokens.refreshToken;
    } else {
      throw new Error("No refresh token available");
    }
  }

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
  refreshToken = res.data.refresh_token || refreshToken;

  await redis.set('lightspeed_tokens', JSON.stringify({ accessToken, refreshToken }));
  console.log("✅ Tokens refreshed and saved to Upstash Redis");

  return accessToken;
}

async function loadTokens() {
  const saved = await redis.get('lightspeed_tokens');
  if (saved) {
    const tokens = JSON.parse(saved);
    accessToken = tokens.accessToken;
    refreshToken = tokens.refreshToken;
    console.log("Tokens loaded from Upstash Redis");
  }
}

loadTokens(); // Load on startup

// Keep your authHeader, hasValidToken, getItemBySystemSku, createSale as-is
// (with 401 retry calling refreshAccessToken)

/* EXPORTS */
module.exports = {
  exchangeCodeForToken,
  hasValidToken,
  getItemBySystemSku,
  createSale
};