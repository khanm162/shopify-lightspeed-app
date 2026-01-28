require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const lightspeedAuth = require("./routes/lightspeedAuth");
const {
  hasValidToken,
  getItemBySystemSku,
  createSale,
  refreshAccessToken
} = require("./services/lightspeed");

const { Redis } = require('@upstash/redis');
const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const app = express();
const PORT = process.env.PORT || 3000;
const processedOrders = new Set();

// In-memory storage for ALL orders (success + failed + skipped + retried)
const orderLogs = [];

// In-memory failed orders (for quick dashboard access)
const failedOrders = [];

// Load failed orders from Redis on startup (persistent)
async function loadFailedOrders() {
  try {
    const queued = await redis.lrange('failed_queue', 0, -1);
    queued.forEach(item => {
      const data = JSON.parse(item);
      failedOrders.push(data);
      // Also add to orderLogs if not already there
      if (!orderLogs.some(o => o.shopifyOrderId === data.shopifyOrderId)) {
        orderLogs.push({
          shopifyOrderId: data.shopifyOrderId,
          shopDomain: data.shopDomain,
          lsCustomerID: data.lsCustomerID,
          timestamp: data.timestamp,
          status: data.retryCount > 0 ? `retrying (${data.retryCount}/5)` : "failed",
          products: data.products || [],
          errorMessage: "Queued for auto-retry"
        });
      }
    });
    console.log(`Loaded ${queued.length} failed orders from Redis`);
  } catch (err) {
    console.error("Failed to load queued orders:", err.message);
  }
}
loadFailedOrders();

// Dashboard: HTML table view of all orders
app.get("/dashboard", (req, res) => {
  res.render('orders', { 
    totalOrders: orderLogs.length, 
    orders: orderLogs.map(o => ({
      shopifyOrderId: o.shopifyOrderId,
      shopDomain: o.shopDomain,
      lsCustomerID: o.lsCustomerID,
      timestamp: o.timestamp,
      status: o.status,
      products: o.products,
      lsSaleID: o.lsSaleID,
      errorMessage: o.errorMessage
    }))
  });
});

// JSON API for all orders
app.get("/dashboard/orders", (req, res) => {
  res.json({
    totalOrders: orderLogs.length,
    orders: orderLogs
  });
});

// Fixed: Failed orders dashboard (JSON) - safety check
app.get("/dashboard/failed", (req, res) => {
  res.json({
    failedCount: failedOrders.length,
    failedOrders: failedOrders.map(f => ({
      shopifyOrderId: f.shopifyOrderId || "unknown",
      shopDomain: f.shopDomain || "unknown",
      lsCustomerID: f.lsCustomerID || "unknown",
      timestamp: f.timestamp || new Date().toISOString(),
      errorMessage: f.errorMessage || "Unknown error",
      errorDetails: f.errorDetails || "No details",
      retryCount: f.retryCount || 0
    }))
  });
});

// Re-sync endpoint (manual)
app.post("/resync/:orderId", async (req, res) => {
  const orderId = req.params.orderId;
  const failed = failedOrders.find(f => f.shopifyOrderId === orderId);
  if (!failed) return res.status(404).json({ error: "Order not found in failed list" });

  try {
    console.log(`Manual re-sync for #${orderId} from ${failed.shopDomain}`);
    const saleLines = failed.saleLines || [];
    await createSale({
      saleLines,
      customerID: Number(failed.lsCustomerID)
    });
    failedOrders.splice(failedOrders.indexOf(failed), 1);
    await redis.lrem('failed_queue', 0, JSON.stringify(failed)); // Remove from queue
    const logEntry = orderLogs.find(o => o.shopifyOrderId === orderId);
    if (logEntry) logEntry.status = "success (manual retry)";
    res.json({ success: true, message: `Re-sync successful for order #${orderId}` });
  } catch (err) {
    console.error(`Manual re-sync failed for #${orderId}:`, err.message);
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

// NEW: Cron job to auto-retry failed orders every 10 minutes
app.get("/cron/retry-failed", async (req, res) => {
  try {
    const queued = await redis.lrange('failed_queue', 0, 9); // Process up to 10 at a time
    if (queued.length === 0) return res.send("No failed orders to retry");

    for (const item of queued) {
      const data = JSON.parse(item);
      if (data.retryCount >= 5) {
        console.log(`Max retries reached for #${data.shopifyOrderId}`);
        await redis.lrem('failed_queue', 1, item);
        const log = orderLogs.find(o => o.shopifyOrderId === data.shopifyOrderId);
        if (log) log.status = "permanent fail (max retries)";
        continue;
      }

      try {
        await createSale({
          saleLines: data.saleLines,
          customerID: Number(data.lsCustomerID)
        });
        console.log(`Auto-retry success for #${data.shopifyOrderId}`);
        await redis.lrem('failed_queue', 1, item);
        failedOrders = failedOrders.filter(f => f.shopifyOrderId !== data.shopifyOrderId);
        const log = orderLogs.find(o => o.shopifyOrderId === data.shopifyOrderId);
        if (log) log.status = "success (auto-retried)";
      } catch (retryErr) {
        console.error(`Auto-retry failed for #${data.shopifyOrderId}:`, retryErr.message);
        data.retryCount = (data.retryCount || 0) + 1;
        await redis.lrem('failed_queue', 1, item);
        await redis.lpush('failed_queue', JSON.stringify(data)); // Re-queue
        const log = orderLogs.find(o => o.shopifyOrderId === data.shopifyOrderId);
        if (log) log.status = `retrying (${data.retryCount}/5)`;
      }
    }

    res.send(`Processed ${queued.length} queued retries`);
  } catch (err) {
    console.error("Retry cron error:", err.message);
    res.status(500).send("Retry failed");
  }
});

app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

app.get("/", (_, res) => res.send("Server running"));

app.post("/webhooks/orders-create", async (req, res) => {
  const shopDomain = req.get("X-Shopify-Shop-Domain");
  if (!shopDomain) return res.status(400).send("Missing shop domain");
  console.log(`Webhook received from Shopify store: ${shopDomain}`);

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
  if (!webhookSecret || !lsCustomerID) return res.status(401).send("Unauthorized - unknown store");

  const hmac = crypto.createHmac("sha256", webhookSecret).update(req.rawBody).digest("base64");
  if (hmac !== req.get("X-Shopify-Hmac-Sha256")) return res.status(401).send("Unauthorized");

  console.log(`Webhook verified successfully for ${shopDomain}`);

  const order = req.body;

  if (processedOrders.has(order.id)) return res.status(200).send("OK");
  processedOrders.add(order.id);

  if (!hasValidToken()) {
    console.log("⏳ Lightspeed token not ready yet. Skipping order.");
    orderLogs.push({
      shopifyOrderId: order.id,
      shopDomain,
      lsCustomerID,
      timestamp: new Date().toISOString(),
      status: "skipped",
      products: order.line_items?.map(i => ({ sku: i.sku?.trim(), quantity: i.quantity })) || [],
      errorMessage: "Lightspeed token not ready",
      errorDetails: "Token expired or missing — cron refresh should handle"
    });
    return res.status(200).send("OK");
  }

  try {
    console.log(`📦 Processing Shopify order #${order.id} from ${shopDomain} - Total: $${order.total_price}`);

    const saleLines = [];
    const products = [];
    for (const item of order.line_items || []) {
      const shopifySku = item.sku?.trim();
      if (!shopifySku) continue;
      try {
        const lsItem = await getItemBySystemSku(shopifySku);
        saleLines.push({
          itemID: Number(lsItem.itemID),
          quantity: Number(item.quantity),
          unitPrice: Number(item.price)
        });
        products.push({ sku: shopifySku, quantity: Number(item.quantity), title: item.title });
      } catch (lookupErr) {
        console.warn(` → Failed to find item: ${lookupErr.message}`);
      }
    }

    if (saleLines.length === 0) return res.status(200).send("OK - No syncable items");

    console.log(`📊 Creating sale for Lightspeed customer ${lsCustomerID} with ${saleLines.length} line(s)`);
    const saleResult = await createSale({
      saleLines,
      customerID: Number(lsCustomerID)
    });

    console.log(`🎉 Sale created successfully for Shopify order #${order.id} from ${shopDomain}`);

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
    const errorInfo = {
      shopifyOrderId: order.id,
      shopDomain,
      lsCustomerID,
      timestamp: new Date().toISOString(),
      errorMessage: err.message,
      errorDetails: err.response?.data || err.stack || err.toString(),
      saleLines: saleLines, // Save attempted lines for retry
      retryCount: 0,
      lineItemsCount: order.line_items?.length || 0
    };
    failedOrders.push(errorInfo);
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

    // Push to retry queue
    await redis.lpush('failed_queue', JSON.stringify(errorInfo));
    console.log(`Order #${order.id} added to auto-retry queue`);

    console.error(`❌ Order sync failed for #${order?.id || "unknown"} from ${shopDomain}`);
    console.error("Failure details:", JSON.stringify(errorInfo, null, 2));
    res.status(500).send("Internal Server Error");
  }
});

app.use("/lightspeed", lightspeedAuth);

app.listen(PORT, () =>
  console.log(`🚀 Server running on http://localhost:${PORT}`)
);