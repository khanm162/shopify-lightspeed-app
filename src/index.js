require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const lightspeedAuth = require("./routes/lightspeedAuth");
const {
  hasValidToken,
  getItemBySystemSku,
  createSale
} = require("./services/lightspeed");

const app = express();
const PORT = process.env.PORT || 3000;
const processedOrders = new Set();

// In-memory storage for ALL orders (success + failed) — resets on restart
const orderLogs = [];

// Dashboard: View ALL orders (success + failed)
app.get("/dashboard/orders", (req, res) => {
  res.json({
    totalOrders: orderLogs.length,
    orders: orderLogs.map(o => ({
      shopifyOrderId: o.shopifyOrderId,
      shopDomain: o.shopDomain,
      lsCustomerID: o.lsCustomerID,
      timestamp: o.timestamp,
      status: o.status,
      products: o.products, // array of { sku, quantity }
      lsSaleID: o.lsSaleID || null,
      errorMessage: o.errorMessage || null,
      errorDetails: o.errorDetails || null
    }))
  });
});

// In-memory storage for failed orders (subset of orderLogs)
const failedOrders = [];

// Dashboard: View only failed orders (kept for compatibility)
app.get("/dashboard/failed", (req, res) => {
  res.json({
    failedCount: failedOrders.length,
    failedOrders: failedOrders.map(f => ({
      shopifyOrderId: f.shopifyOrderId,
      shopDomain: f.shopDomain,
      lsCustomerID: f.lsCustomerID,
      timestamp: f.timestamp,
      errorMessage: f.errorMessage,
      errorDetails: f.errorDetails
    }))
  });
});

// Re-sync endpoint (POST to retry a failed order)
app.post("/resync/:orderId", async (req, res) => {
  const orderId = req.params.orderId;
  const failed = failedOrders.find(f => f.shopifyOrderId === orderId);

  if (!failed) {
    return res.status(404).json({ error: "Order not found in failed list" });
  }

  try {
    console.log(`Manual re-sync requested for order #${orderId} from ${failed.shopDomain}`);

    // Re-run the sync (expand if you saved full saleLines earlier)
    const saleLines = failed.saleLines || []; // If you saved them earlier
    await createSale({
      saleLines,
      customerID: Number(failed.lsCustomerID)
    });

    // Remove from failed list on success
    failedOrders.splice(failedOrders.indexOf(failed), 1);

    // Update status in orderLogs (optional - optional)
    const logEntry = orderLogs.find(o => o.shopifyOrderId === orderId);
    if (logEntry) logEntry.status = "success";

    res.json({ success: true, message: `Re-sync successful for order #${orderId}` });
  } catch (err) {
    console.error(`Re-sync failed for #${orderId}:`, err.message);
    res.status(500).json({ error: "Re-sync failed", details: err.message });
  }
});

// Token refresh endpoint for cron
app.get("/refresh-token", async (req, res) => {
  try {
    if (!hasValidToken()) {
      await refreshAccessToken();
      console.log("Token refreshed via cron");
      res.send("Token refreshed successfully");
    } else {
      res.send("Token still valid");
    }
  } catch (err) {
    console.error("Cron refresh failed:", err.message);
    res.status(500).send("Refresh failed");
  }
});

app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf; // Required for Shopify HMAC verification
  }
}));

app.get("/", (_, res) => res.send("Server running"));

app.post("/webhooks/orders-create", async (req, res) => {
  // 1. Get shop domain from Shopify header
  const shopDomain = req.get("X-Shopify-Shop-Domain");
  if (!shopDomain) {
    console.warn("⚠️ Missing X-Shopify-Shop-Domain header");
    return res.status(400).send("Missing shop domain");
  }
  console.log(`Webhook received from Shopify store: ${shopDomain}`);

  // 2. Find the corresponding webhook secret and Lightspeed customer ID
  let webhookSecret;
  let lsCustomerID;
  for (const key in process.env) {
    if (key.endsWith("_DOMAIN") && process.env[key] === shopDomain) {
      const prefix = key.replace("_DOMAIN", "");
      webhookSecret = process.env[`${prefix}_WEBHOOK_SECRET`];
      lsCustomerID = process.env[`${prefix}_LS_CUSTOMER`];
      break;
    }
  }
  if (!webhookSecret || !lsCustomerID) {
    console.warn(`⚠️ No mapping found for domain: ${shopDomain}`);
    return res.status(401).send("Unauthorized - unknown store");
  }

  // 3. Verify HMAC using the correct per-store secret
  const hmac = crypto
    .createHmac("sha256", webhookSecret)
    .update(req.rawBody)
    .digest("base64");
  if (hmac !== req.get("X-Shopify-Hmac-Sha256")) {
    console.warn(`⚠️ Invalid HMAC for ${shopDomain}`);
    return res.status(401).send("Unauthorized");
  }
  console.log(`Webhook verified successfully for ${shopDomain}`);

  // 4. Check Lightspeed token
  if (!hasValidToken()) {
    console.log("⏳ Lightspeed token not ready yet. Skipping order.");
    return res.status(200).send("OK");
  }

  const order = req.body;

  // 5. Prevent duplicate processing
  if (processedOrders.has(order.id)) {
    console.log("🔁 Duplicate webhook ignored:", order.id);
    return res.status(200).send("OK");
  }
  processedOrders.add(order.id);

  try {
    console.log(`📦 Processing Shopify order #${order.id} from ${shopDomain} - Total: $${order.total_price}`);

    const saleLines = [];
    const products = []; // For dashboard tracking

    for (const item of order.line_items || []) {
      const shopifySku = item.sku?.trim();
      if (!shopifySku) {
        console.warn(`⚠️ Skipping item without SKU: "${item.title}" (variant ID: ${item.variant_id})`);
        continue;
      }
      console.log(`🛒 Looking up item: "${item.title}" - SKU: ${shopifySku}`);
      try {
        const lsItem = await getItemBySystemSku(shopifySku);
        saleLines.push({
          itemID: Number(lsItem.itemID),
          quantity: Number(item.quantity),
          unitPrice: Number(item.price)
        });
        products.push({
          sku: shopifySku,
          quantity: Number(item.quantity),
          title: item.title
        });
        console.log(` → Added: itemID ${lsItem.itemID} × ${item.quantity} @ $${item.price}`);
      } catch (lookupErr) {
        console.warn(` → Failed to find item in Lightspeed: ${lookupErr.message}`);
        // Continue — don't fail entire order
      }
    }

    if (saleLines.length === 0) {
      console.warn(`⚠️ No valid items could be synced for order #${order.id}`);
      return res.status(200).send("OK - No syncable items");
    }

    console.log(`📊 Creating sale for Lightspeed customer ${lsCustomerID} with ${saleLines.length} line(s)`);

    const saleResult = await createSale({
      saleLines,
      customerID: Number(lsCustomerID)
    });

    console.log(`🎉 Sale created successfully for Shopify order #${order.id} from ${shopDomain}`);

    // Log success
    orderLogs.push({
      shopifyOrderId: order.id,
      shopDomain,
      lsCustomerID,
      timestamp: new Date().toISOString(),
      status: "success",
      products,
      lsSaleID: saleResult.saleID || "unknown"
    });

    res.status(200).send("OK");
  } catch (err) {
    // Capture failure details
    const errorInfo = {
      shopifyOrderId: order.id,
      shopDomain,
      lsCustomerID,
      timestamp: new Date().toISOString(),
      errorMessage: err.message,
      errorDetails: err.response?.data || err.stack || err.toString(),
      lineItemsCount: order.line_items?.length || 0
    };

    failedOrders.push(errorInfo);

    // Log failure
    orderLogs.push({
      shopifyOrderId: order.id,
      shopDomain,
      lsCustomerID,
      timestamp: new Date().toISOString(),
      status: "failed",
      products: order.line_items?.map(i => ({ sku: i.sku?.trim(), quantity: i.quantity })) || [],
      errorMessage: err.message,
      errorDetails: err.response?.data || err.stack || err.toString()
    });

    console.error(`❌ Order sync failed for Shopify order #${order?.id || "unknown"} from ${shopDomain}`);
    console.error("Failure details:", JSON.stringify(errorInfo, null, 2));

    res.status(500).send("Internal Server Error");
  }
});

app.use("/lightspeed", lightspeedAuth);

app.listen(PORT, () =>
  console.log(`🚀 Server running on http://localhost:${PORT}`)
);