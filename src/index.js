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

let redis;
try {
  if (!process.env.REDIS_URL) {
    console.error("REDIS_URL is missing in environment variables!");
  } else {
    redis = new Redis({
      url: process.env.REDIS_URL,
    });
    console.log("Redis client initialized successfully with REDIS_URL");
  }
} catch (err) {
  console.error("Redis initialization failed:", err.message);
}

const app = express();
const PORT = process.env.PORT || 3000;
const processedOrders = new Set();

// Persistent storage
let orderLogs = [];
let failedOrders = [];

async function loadOrdersFromRedis() {
  if (!redis) {
    console.warn("Redis not initialized - skipping load");
    return;
  }

  try {
    const savedOrders = await redis.lrange('order_history', 0, -1) || [];
    orderLogs = savedOrders
      .map(item => {
        try {
          return JSON.parse(item);
        } catch (parseErr) {
          console.error("Corrupted order in order_history:", item);
          return null;
        }
      })
      .filter(Boolean)
      .reverse();

    const savedFailed = await redis.lrange('failed_queue', 0, -1) || [];
    failedOrders = savedFailed
      .map(item => {
        try {
          return JSON.parse(item);
        } catch (parseErr) {
          console.error("Corrupted failed order:", item);
          return null;
        }
      })
      .filter(Boolean)
      .reverse();

    console.log(`Loaded ${orderLogs.length} orders and ${failedOrders.length} queued from Redis`);
  } catch (err) {
    console.error("Failed to load from Redis:", err.message);
  }
}

loadOrdersFromRedis();

const path = require('path');

// Set EJS as view engine - FIXED for Vercel
app.set('view engine', 'ejs');
app.set('views', path.join(process.cwd(), 'views'));

// Dashboard - safe render
app.get("/dashboard", async (req, res) => {
  let enhancedOrders = [];
  let total = 0;

  try {
    // Dynamic store name mapping (your 72 stores)
    const storeNameMap = {};
    for (const key in process.env) {
      if (key.startsWith('SHOPIFY_STORE_') && key.endsWith('_NAME')) {
        const domainKey = key.replace('_NAME', '_DOMAIN');
        const domain = process.env[domainKey];
        if (domain) {
          storeNameMap[domain] = process.env[key];
        }
      }
    }

    enhancedOrders = orderLogs.map(o => ({
      ...o,
      orderNumber: o.orderNumber || o.shopifyOrderId || '-',
      storeName: storeNameMap[o.shopDomain] || o.shopDomain || 'Unknown Store',
      timestamp: o.timestamp || o.created_at || new Date().toISOString(),
    }));

    total = enhancedOrders.length;
  } catch (err) {
    console.error("Dashboard data preparation error:", err.message);
  }

  res.render('orders', {
    totalOrders: total,
    orders: enhancedOrders
  });
});

// Other dashboard routes (unchanged, but safe)
app.get("/dashboard/orders", (req, res) => {
  res.json({
    totalOrders: orderLogs.length,
    orders: orderLogs
  });
});

app.get("/dashboard/failed", (req, res) => {
  res.json({
    failedCount: failedOrders.length,
    failedOrders: failedOrders
  });
});

// Re-sync (unchanged)
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
    if (redis) await redis.lrem('failed_queue', 0, JSON.stringify(failed));
    const logEntry = orderLogs.find(o => o.shopifyOrderId === orderId);
    if (logEntry) logEntry.status = "success (manual retry)";
    if (redis) await redis.lpush('order_history', JSON.stringify(logEntry));
    res.json({ success: true, message: `Re-sync successful for order #${orderId}` });
  } catch (err) {
    console.error(`Re-sync failed for #${orderId}:`, err.message);
    res.status(500).json({ error: "Re-sync failed", details: err.message });
  }
});

// Token refresh (unchanged)
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

// Auto-retry cron (unchanged, but safe Redis calls)
app.get("/cron/retry-failed", async (req, res) => {
  if (!redis) return res.status(503).send("Redis not available");

  try {
    const queued = await redis.lrange('failed_queue', 0, 9);
    if (queued.length === 0) return res.send("No queued orders to retry");

    for (const item of queued) {
      let data;
      try {
        data = JSON.parse(item);
      } catch (e) {
        console.error("Corrupted queued item:", item);
        await redis.lrem('failed_queue', 1, item);
        continue;
      }

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
        await redis.lpush('failed_queue', JSON.stringify(data));
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

  // TEMPORARY HMAC BYPASS FOR MANUAL RESYNC
  const isManualTest = req.query.manual === 'true';
  if (!isManualTest) {
    const hmac = crypto.createHmac("sha256", webhookSecret).update(req.rawBody).digest("base64");
    if (hmac !== req.get("X-Shopify-Hmac-Sha256")) {
      console.warn(`HMAC mismatch for ${shopDomain} - returning 401`);
      return res.status(401).send("Unauthorized");
    }
  }
  console.log(`Webhook verified successfully for ${shopDomain} (manual test: ${isManualTest})`);

  const order = req.body;
  if (processedOrders.has(order.id)) return res.status(200).send("OK");
  processedOrders.add(order.id);

  if (!hasValidToken()) {
    console.log("⏳ Lightspeed token not ready yet. Skipping order.");
    const skipInfo = {
      shopifyOrderId: order.id,
      shopDomain,
      lsCustomerID,
      timestamp: new Date().toISOString(),
      status: "skipped",
      products: order.line_items?.map(i => ({ sku: i.sku?.trim(), quantity: i.quantity })) || [],
      errorMessage: "Lightspeed token not ready",
      errorDetails: "Token expired or missing — cron refresh should handle",
      retryCount: 0,
      saleLines: []
    };
    orderLogs.push(skipInfo);
    if (redis) {
      await redis.lpush('order_history', JSON.stringify(skipInfo)).catch(e => console.error("Redis push failed:", e));
      await redis.lpush('failed_queue', JSON.stringify(skipInfo)).catch(e => console.error("Redis push failed:", e));
    }
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
    const successLog = {
      shopifyOrderId: order.id,
      shopDomain,
      lsCustomerID,
      timestamp: new Date().toISOString(),
      status: "success",
      products,
      lsSaleID: saleResult.saleID || "unknown"
    };
    orderLogs.push(successLog);
    if (redis) await redis.lpush('order_history', JSON.stringify(successLog)).catch(e => console.error("Redis push failed:", e));
    res.status(200).send("OK");
  } catch (err) {
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
      await redis.lpush('order_history', JSON.stringify(errorInfo)).catch(e => console.error("Redis push failed:", e));
      await redis.lpush('failed_queue', JSON.stringify(errorInfo)).catch(e => console.error("Redis push failed:", e));
    }
    console.error(`❌ Order sync failed for #${order?.id || "unknown"} from ${shopDomain}`);
    console.error("Failure details:", JSON.stringify(errorInfo, null, 2));
    res.status(500).send("Internal Server Error");
  }
});

app.use("/lightspeed", lightspeedAuth);

app.listen(PORT, () =>
  console.log(`🚀 Server running on http://localhost:${PORT}`)
);