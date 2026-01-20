const express = require("express");
const router = express.Router();

const {
  exchangeCodeForToken
} = require("../services/lightspeed");

router.get("/auth", (req, res) => {
  const url =
    `https://cloud.lightspeedapp.com/auth/oauth/authorize` +
    `?response_type=code` +
    `&client_id=${process.env.LIGHTSPEED_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(process.env.LIGHTSPEED_REDIRECT_URI)}` +
    `&scope=employee:register employee:all`;

  console.log("DEBUG auth URL:", url);
  res.redirect(url);
});

router.get("/callback", async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.status(400).send("Missing code");

    await exchangeCodeForToken(code);
    res.send("Lightspeed connected successfully");
  } catch (err) {
    console.error("OAuth failed:", err.message);
    res.status(500).send("OAuth failed");
  }
});

module.exports = router;
