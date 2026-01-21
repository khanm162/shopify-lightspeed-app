const express = require("express");
const router = express.Router();
const { exchangeCodeForToken } = require("../services/lightspeed");

router.get("/auth", (req, res) => {
  const redirectUri = process.env.LIGHTSPEED_REDIRECT_URI || "https://shopify-api-sync.vercel.app/lightspeed/callback";

  const url =
    `https://cloud.lightspeedapp.com/auth/oauth/authorize` +
    `?response_type=code` +
    `&client_id=${process.env.LIGHTSPEED_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=employee:register employee:all`;  // ← Only these two — safe & working

  console.log("DEBUG auth URL:", url);
  res.redirect(url);
});

router.get("/callback", async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.status(400).send("Missing code parameter");

    await exchangeCodeForToken(code);
    res.send(`
      <h1>Lightspeed Connected Successfully!</h1>
      <p>Your sync server is now authorized and ready for 24/7 operation.</p>
      <p>You can close this window/tab and return to your setup.</p>
    `);
  } catch (err) {
    console.error("OAuth callback failed:", err.message);
    res.status(500).send("OAuth failed - check server logs");
  }
});

module.exports = router;