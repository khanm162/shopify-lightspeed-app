require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const path = require('path');
const lightspeedAuth = require("./routes/lightspeedAuth");
const {
  hasValidToken,
  getItemBySystemSku,
  createSale,
  refreshAccessToken
} = require("./services/lightspeed");
const { Redis } = require('@upstash/redis');
// Safe stringify - handles undefined, errors, BigInt, etc.
function safeStringify(obj) {
  return JSON.stringify(obj, (key, value) => {
    if (value === undefined) return null;
    if (value instanceof Error) return { message: value.message, stack: value.stack };
    if (typeof value === 'bigint') return value.toString();
    return value;
  }, 2);
}
// Initialize Redis
let redis = null;
if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
  console.error("CRITICAL: KV_REST_API_URL or KV_REST_API_TOKEN missing! Redis disabled.");
} else {
  try {
    redis = new Redis({
      url: process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
    });
    console.log("Redis client initialized successfully");
  } catch (err) {
    console.error("Redis client creation failed:", err.message);
    redis = null;
  }
}
const app = express();
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));
const PORT = process.env.PORT || 3000;
const processedOrders = new Set();
// Persistent storage
let orderLogs = [];
let failedOrders = [];
async function loadOrdersFromRedis() {
  if (!redis) return console.warn("Redis not initialized - skipping load");
  try {
    const savedOrders = await redis.lrange('order_history', 0, -1) || [];
    orderLogs = savedOrders
      .map(item => {
        if (typeof item !== 'string') {
          console.warn("Startup: Non-string in order_history:", item);
          return null;
        }
        try { return JSON.parse(item); }
        catch (e) { console.error("Startup corrupted:", item.substring(0, 200)); return null; }
      })
      .filter(Boolean)
      .reverse();
    const savedFailed = await redis.lrange('failed_queue', 0, -1) || [];
    failedOrders = savedFailed
      .map(item => {
        if (typeof item !== 'string') {
          console.warn("Startup: Non-string in failed_queue:", item);
          return null;
        }
        try { return JSON.parse(item); }
        catch (e) { console.error("Startup failed corrupted:", item.substring(0, 200)); return null; }
      })
      .filter(Boolean)
      .reverse();
    console.log(`Startup load: ${orderLogs.length} orders, ${failedOrders.length} failed`);
  } catch (err) {
    console.error("Startup Redis load failed:", err.message);
  }
}
loadOrdersFromRedis();
// EJS setup
app.set('view engine', 'ejs');
app.set('views', path.join(process.cwd(), 'views'));
// Dashboard
app.get("/dashboard", async (req, res) => {
  let enhancedOrders = [];
  let total = 0;

  if (!redis) {
    console.warn("Redis unavailable - dashboard empty");
    return res.render('orders', { totalOrders: 0, orders: [] });
  }

  try {
    const storeNameMap = {};
    for (const key in process.env) {
      if (key.startsWith('SHOPIFY_STORE_') && key.endsWith('_NAME')) {
        const domainKey = key.replace('_NAME', '_DOMAIN');
        const domain = process.env[domainKey];
        if (domain) storeNameMap[domain] = process.env[key];
      }
    }

    const rawOrders = await redis.lrange('order_history', 0, -1) || [];
    console.log(`[DASHBOARD] Fetched ${rawOrders.length} raw items`);

    const orders = rawOrders
      .map((item, idx) => {
        if (item === null || item === undefined) {
          console.warn(`[DASHBOARD] Null item at #${idx}`);
          return null;
        }
        const itemType = typeof item;
        console.log(`[DASHBOARD] Item #${idx} type: ${itemType}`);
        if (itemType === 'object' && item !== null) {
          console.log(`[DASHBOARD] Using pre-parsed object #${idx} (ID: ${item.shopifyOrderId || 'unknown'})`);
          return item;
        }
        if (itemType === 'string') {
          try {
            const parsed = JSON.parse(item);
            console.log(`[DASHBOARD] Parsed string item #${idx} OK`);
            return parsed;
          } catch (err) {
            console.error(`[DASHBOARD] Parse fail on string #${idx}:`, err.message);
            console.error("Raw string preview:", item.substring(0, 300));
            return null;
          }
        }
        console.error(`[DASHBOARD] Unexpected item type #${idx}:`, itemType, item);
        return null;
      })
      .filter(Boolean);

    enhancedOrders = orders.map(o => ({
  ...o,
  orderNumber: o.name || o.orderNumber || o.shopifyOrderId || '-',
  storeName: storeNameMap[o.shopDomain] || o.shopDomain || 'Unknown Store',
  timestamp: o.timestamp || o.created_at || new Date().toISOString(),
}));

// Sort newest first (descending timestamp)
enhancedOrders.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

total = enhancedOrders.length;
console.log(`[DASHBOARD] Rendered ${total} sorted orders (newest first)`);

    total = enhancedOrders.length;
    console.log(`[DASHBOARD] Rendered ${total} orders`);
  } catch (err) {
    console.error("Dashboard load error:", err.message);
  }

  res.render('orders', {
    totalOrders: total,
    orders: enhancedOrders
  });
});
// Re-sync failed/skipped order (POST)
app.post("/resync/:orderId", async (req, res) => {
  console.log(`[RESYNC] POST request received for orderId: ${req.params.orderId}`);

  if (!redis) return res.status(500).json({ error: "Redis not available" });

  try {
    const orderId = req.params.orderId;

    // Load all failed items from Redis (instead of memory)
    const queued = await redis.lrange('failed_queue', 0, -1) || [];
    let failedItem = null;

    for (const item of queued) {
      try {
        const parsed = JSON.parse(item);
        if (parsed.shopifyOrderId === orderId) {
          failedItem = parsed;
          break;
        }
      } catch (e) {
        console.error("[RESYNC] Skipping corrupted item in queue:", item.substring(0, 200));
        await redis.lrem('failed_queue', 1, item); // auto-remove bad items
      }
    }

    if (!failedItem) {
      console.log("[RESYNC] Order not found in Redis failed_queue");
      return res.status(404).json({ error: "Order not found in failed list" });
    }

    console.log(`[RESYNC] Found failed item in Redis: #${orderId} from ${failedItem.shopDomain}`);

    const saleLines = failedItem.saleLines || [];
    await createSale({
      saleLines,
      customerID: Number(failedItem.lsCustomerID)
    });

    // Remove from Redis queue
    await redis.lrem('failed_queue', 0, JSON.stringify(failedItem));
    console.log("[RESYNC] Removed from failed_queue");

    // Optional: Update order_history status
    const historyItems = await redis.lrange('order_history', 0, -1) || [];
    for (const hist of historyItems) {
      try {
        const parsed = JSON.parse(hist);
        if (parsed.shopifyOrderId === orderId) {
          parsed.status = "success (manual retry)";
          await redis.lrem('order_history', 0, hist);
          await redis.lpush('order_history', JSON.stringify(parsed));
          console.log("[RESYNC] Updated status in order_history");
          break;
        }
      } catch (e) {}
    }

    res.json({ success: true, message: `Re-sync successful for order #${orderId}` });
  } catch (err) {
    console.error(`[RESYNC] Failed for #${req.params.orderId}:`, err.message);
    res.status(500).json({ error: "Re-sync failed", details: err.message });
  }
});
// Token refresh (improved logging)
app.get("/refresh-token", async (req, res) => {
  console.log(`[TOKEN-CRON] Refresh called at ${new Date().toISOString()}`);
  try {
    const isValid = await hasValidToken(); // ← add await
    console.log(`[TOKEN-CRON] Token valid? ${isValid}`);
    if (!isValid) {
      console.log("[TOKEN-CRON] Refreshing token...");
      await refreshAccessToken();
      console.log("[TOKEN-CRON] Refresh SUCCESS");
      res.send("Token refreshed successfully");
    } else {
      console.log("[TOKEN-CRON] Token still valid");
      res.send("Token still valid");
    }
  } catch (err) {
    console.error("[TOKEN-CRON] REFRESH FAILED:", err.message);
    res.status(500).send("Refresh failed");
  }
});
// Auto-retry failed orders (called by cron)
app.get("/cron/retry-failed", async (req, res) => {
  if (!redis) return res.status(503).send("Redis not available");
  try {
    const queued = await redis.lrange('failed_queue', 0, 9);
    if (queued.length === 0) return res.send("No queued orders to retry");

    console.log(`[RETRY-CRON] Processing ${queued.length} queued failed orders`);

    for (const item of queued) {
      // Log safely – check type first
      if (typeof item === 'string') {
        console.log("[RETRY-CRON] Raw item preview:", item.substring(0, 300));
      } else if (typeof item === 'object') {
        console.log("[RETRY-CRON] Parsed object item:", JSON.stringify(item, null, 2).substring(0, 300));
      } else {
        console.warn("[RETRY-CRON] Unexpected item type:", typeof item);
      }

      let data;
      try {
        // If it's already an object (auto-parsed by SDK), use it directly
        if (typeof item === 'object' && item !== null) {
          data = item;
        } else {
          data = JSON.parse(item);
        }
      } catch (e) {
        console.error("[RETRY-CRON] Parse failed - removing corrupted item");
        await redis.lrem('failed_queue', 1, item); // Auto-remove
        continue;
      }

      if (data.retryCount >= 5) {
        console.log(`[RETRY-CRON] Max retries reached for #${data.shopifyOrderId}`);
        await redis.lrem('failed_queue', 1, item);
        continue;
      }

      try {
        await createSale({
          saleLines: data.saleLines || [],
          customerID: Number(data.lsCustomerID)
        });
        console.log(`[RETRY-CRON] Success for #${data.shopifyOrderId}`);
        await redis.lrem('failed_queue', 1, item);
        failedOrders = failedOrders.filter(f => f.shopifyOrderId !== data.shopifyOrderId);
      } catch (retryErr) {
        console.error(`[RETRY-CRON] Failed for #${data.shopifyOrderId}:`, retryErr.message);
        data.retryCount = (data.retryCount || 0) + 1;
        await redis.lrem('failed_queue', 1, item);
        await redis.lpush('failed_queue', JSON.stringify(data));
      }
    }

    res.send(`Processed ${queued.length} queued retries`);
  } catch (err) {
    console.error("[RETRY-CRON] Critical error:", err.message);
    res.status(500).send("Retry failed");
  }
});
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
  // ── TEMPORARY HMAC BYPASS FOR MANUAL RESYNC ────────────────────────────────
  const isManualTest = req.query.manual === 'true';
  if (!isManualTest) {
    const hmac = crypto.createHmac("sha256", webhookSecret).update(req.rawBody).digest("base64");
    if (hmac !== req.get("X-Shopify-Hmac-Sha256")) {
      console.warn(`HMAC mismatch for ${shopDomain} - returning 401`);
      return res.status(401).send("Unauthorized");
    }
  }
  console.log(`Webhook verified successfully for ${shopDomain} (manual test: ${isManualTest})`);
  // ──────────────────────────────────────────────────────────────────────────────
  const order = req.body;
  if (processedOrders.has(order.id)) return res.status(200).send("OK");
  processedOrders.add(order.id);
  if (!(await hasValidToken())) {  // ← add await
  console.log("[WEBHOOK] Token not ready - attempting auto-refresh...");
  try {
    await refreshAccessToken();
    console.log("[WEBHOOK] Token refreshed successfully - retrying sync");
  } catch (refreshErr) {
    console.error("[WEBHOOK] Auto-refresh failed:", refreshErr.message);
    // Only skip if refresh really failed
    const skipInfo = {
      shopifyOrderId: order.id,
      shopDomain,
      lsCustomerID,
      timestamp: new Date().toISOString(),
      status: "skipped",
      products: order.line_items?.map(i => ({ sku: i.sku?.trim(), quantity: i.quantity })) || [],
      errorMessage: "Lightspeed token not ready after refresh attempt",
      errorDetails: refreshErr.message || "Token expired or missing",
      retryCount: 0,
      saleLines: []
    };
    orderLogs.push(skipInfo);
    if (redis) {
      const stringified = safeStringify(skipInfo);
      console.log("[WEBHOOK] Saving skip log:", stringified.substring(0, 200));
      await redis.lpush('order_history', stringified);
      await redis.lpush('failed_queue', stringified);
    }
    return res.status(200).send("OK");
  }
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
    const successLog = {
  shopifyOrderId: order.id,
  name: order.name,
  shopDomain,
  lsCustomerID,
  timestamp: new Date().toISOString(),
  status: "success",
  products,
  lsSaleID: saleResult.saleID || "unknown"
};
orderLogs.push(successLog);
if (redis) {
  const stringified = safeStringify(successLog);
  console.log("[WEBHOOK] Saving success log:", stringified.substring(0, 200));
  await redis.lpush('order_history', stringified);
}
res.status(200).send("OK");
  } catch (err) {
    const errorInfo = {
      shopifyOrderId: order.id,
  name: order.name,
      shopDomain,
      lsCustomerID,
      timestamp: new Date().toISOString(),
      errorMessage: err.message,
      errorDetails: err.response?.data || err.stack || err.toString(),
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
    if (redis) {
  const stringified = safeStringify(errorInfo);
  console.log("[WEBHOOK] Saving error log:", stringified.substring(0, 200));
  await redis.lpush('order_history', stringified);
  await redis.lpush('failed_queue', stringified);
}
console.error(`❌ Order sync failed...`);
res.status(500).send("Internal Server Error");
  }
});
app.use("/lightspeed", lightspeedAuth);
app.listen(PORT, () =>
  console.log(`🚀 Server running on http://localhost:${PORT}`)
);