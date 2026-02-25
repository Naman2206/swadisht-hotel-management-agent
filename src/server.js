require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const multer = require('multer');

const { initializeDatabase } = require('./db/init');
const { run, get, all } = require('./db/database');
const { calculateBill } = require('./services/billing');
const { generatePaymentQR } = require('./services/payment');
const {
  sendWhatsAppMessage,
  parseOrderText,
  parseRatingText,
  extractTwilioInbound,
  extractMetaInbound
} = require('./services/whatsapp');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

async function findOrCreateCustomer(phone, name) {
  let customer = await get('SELECT * FROM customers WHERE phone = ?', [phone]);
  if (!customer) {
    const created = await run('INSERT INTO customers(phone, name) VALUES(?, ?)', [phone, name || null]);
    customer = await get('SELECT * FROM customers WHERE id = ?', [created.lastID]);
  } else if (name && name !== customer.name) {
    await run('UPDATE customers SET name = ? WHERE id = ?', [name, customer.id]);
    customer.name = name;
  }
  return customer;
}

async function resolveOrderItems(inputItems) {
  const resolved = [];

  for (const item of inputItems) {
    const quantity = Number(item.quantity || item.qty || 1);
    if (!quantity || quantity < 1) continue;

    let menuItem = null;
    if (item.menuItemId || item.menu_item_id) {
      menuItem = await get('SELECT * FROM menu_items WHERE id = ? AND is_active = 1', [item.menuItemId || item.menu_item_id]);
    } else if (item.name) {
      menuItem = await get('SELECT * FROM menu_items WHERE LOWER(name) = LOWER(?) AND is_active = 1', [item.name]);
    }

    if (!menuItem) {
      throw new Error(`Menu item not found: ${item.name || item.menuItemId || item.menu_item_id}`);
    }

    const lineTotal = Number((menuItem.price * quantity).toFixed(2));
    resolved.push({ menuItemId: menuItem.id, name: menuItem.name, quantity, unitPrice: menuItem.price, lineTotal });
  }

  if (!resolved.length) throw new Error('No valid items in order.');
  return resolved;
}

async function createOrder({ phone, name, source, items }) {
  const customer = await findOrCreateCustomer(phone, name);
  const resolvedItems = await resolveOrderItems(items);
  const bill = calculateBill(resolvedItems);

  const orderInsert = await run(
    `INSERT INTO orders(customer_id, source, status, subtotal, gst_percent, gst_amount, total)
     VALUES(?, ?, 'RECEIVED', ?, ?, ?, ?)`,
    [customer.id, source, bill.subtotal, bill.gstPercent, bill.gstAmount, bill.total]
  );

  for (const item of resolvedItems) {
    await run(
      `INSERT INTO order_items(order_id, menu_item_id, quantity, unit_price, line_total)
       VALUES(?, ?, ?, ?, ?)`,
      [orderInsert.lastID, item.menuItemId, item.quantity, item.unitPrice, item.lineTotal]
    );
  }

  const payment = await generatePaymentQR({ amount: bill.total, orderId: orderInsert.lastID });
  await run('UPDATE orders SET payment_qr_data_url = ? WHERE id = ?', [payment.qrDataUrl, orderInsert.lastID]);

  return {
    orderId: orderInsert.lastID,
    customer,
    items: resolvedItems,
    bill,
    payment
  };
}

function toSqlDateTime(date) {
  return new Date(date).toISOString().slice(0, 19).replace('T', ' ');
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pickRandom(arr) {
  return arr[randomInt(0, arr.length - 1)];
}

function pickRandomUnique(arr, count) {
  const copy = [...arr];
  const result = [];
  while (copy.length && result.length < count) {
    const idx = randomInt(0, copy.length - 1);
    result.push(copy[idx]);
    copy.splice(idx, 1);
  }
  return result;
}

async function ensureRichMenuData() {
  const existing = await all('SELECT * FROM menu_items WHERE is_active = 1 ORDER BY name');
  if (existing.length >= 14) return existing;

  const extendedMenu = [
    ['Veg Biryani', 180],
    ['Chicken Biryani', 260],
    ['Paneer Butter Masala', 220],
    ['Dal Tadka', 150],
    ['Butter Naan', 40],
    ['Garlic Naan', 55],
    ['Masala Dosa', 90],
    ['Idli Sambar', 75],
    ['Veg Fried Rice', 160],
    ['Chicken Fried Rice', 230],
    ['Mutton Curry', 320],
    ['Jeera Rice', 120],
    ['Gulab Jamun', 80],
    ['Lassi', 65],
    ['Filter Coffee', 50],
    ['Fresh Lime Soda', 60]
  ];

  for (const [name, price] of extendedMenu) {
    await run(
      `INSERT INTO menu_items(name, price, is_active) VALUES(?, ?, 1)
       ON CONFLICT(name) DO UPDATE SET price = excluded.price, is_active = 1`,
      [name, price]
    );
  }

  return all('SELECT * FROM menu_items WHERE is_active = 1 ORDER BY name');
}

async function seedDemoData({ customerCount = 1000, reset = false }) {
  if (reset) {
    await run('DELETE FROM feedback');
    await run('DELETE FROM order_items');
    await run('DELETE FROM orders');
    await run('DELETE FROM customers');
    await run('DELETE FROM offers');
  }

  const menu = await ensureRichMenuData();
  const firstNames = ['Aarav', 'Vivaan', 'Aditya', 'Diya', 'Ananya', 'Riya', 'Karan', 'Rohit', 'Neha', 'Priya', 'Ishaan', 'Kavya'];
  const lastNames = ['Sharma', 'Patel', 'Verma', 'Reddy', 'Iyer', 'Gupta', 'Singh', 'Mehta', 'Jain', 'Pillai'];

  let insertedCustomers = 0;
  let insertedOrders = 0;
  let insertedFeedback = 0;

  await run('BEGIN TRANSACTION');
  try {
    for (let i = 0; i < customerCount; i += 1) {
      const phone = `91${String(9000000000 + i).padStart(10, '0').slice(-10)}`;
      const name = `${pickRandom(firstNames)} ${pickRandom(lastNames)}`;
      const createdAt = new Date(Date.now() - randomInt(0, 210) * 24 * 60 * 60 * 1000);

      const customerResult = await run(
        'INSERT OR IGNORE INTO customers(phone, name, created_at) VALUES(?, ?, ?)',
        [phone, name, toSqlDateTime(createdAt)]
      );

      const customer = await get('SELECT id FROM customers WHERE phone = ?', [phone]);
      if (!customer) continue;
      if (customerResult.changes > 0) insertedCustomers += 1;

      const ordersPerCustomer = randomInt(1, 4);
      for (let j = 0; j < ordersPerCustomer; j += 1) {
        const orderDate = new Date(Date.now() - randomInt(0, 180) * 24 * 60 * 60 * 1000 - randomInt(0, 22) * 60 * 60 * 1000);
        const itemCount = randomInt(1, 4);
        const chosenItems = pickRandomUnique(menu, itemCount);
        const orderItems = chosenItems.map((m) => {
          const quantity = randomInt(1, 3);
          const unitPrice = Number(m.price);
          return {
            menuItemId: m.id,
            quantity,
            unitPrice,
            lineTotal: Number((quantity * unitPrice).toFixed(2))
          };
        });
        const bill = calculateBill(orderItems);
        const status = Math.random() < 0.78 ? 'DELIVERED' : 'RECEIVED';
        const deliveredAt = status === 'DELIVERED'
          ? toSqlDateTime(new Date(orderDate.getTime() + randomInt(20, 120) * 60 * 1000))
          : null;

        const orderInsert = await run(
          `INSERT INTO orders(
            customer_id, source, status, subtotal, gst_percent, gst_amount, total, payment_qr_data_url, created_at, delivered_at
          ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            customer.id,
            'seed',
            status,
            bill.subtotal,
            bill.gstPercent,
            bill.gstAmount,
            bill.total,
            null,
            toSqlDateTime(orderDate),
            deliveredAt
          ]
        );
        insertedOrders += 1;

        for (const item of orderItems) {
          await run(
            `INSERT INTO order_items(order_id, menu_item_id, quantity, unit_price, line_total)
             VALUES(?, ?, ?, ?, ?)`,
            [orderInsert.lastID, item.menuItemId, item.quantity, item.unitPrice, item.lineTotal]
          );
        }

        if (status === 'DELIVERED' && Math.random() < 0.63) {
          const ratingWeight = Math.random();
          let rating = 5;
          if (ratingWeight > 0.2 && ratingWeight <= 0.45) rating = 4;
          if (ratingWeight > 0.45 && ratingWeight <= 0.7) rating = 3;
          if (ratingWeight > 0.7 && ratingWeight <= 0.9) rating = 2;
          if (ratingWeight > 0.9) rating = 1;
          const comments = {
            5: 'Excellent taste and quick service.',
            4: 'Good quality food.',
            3: 'Average experience.',
            2: 'Delivery was late.',
            1: 'Food quality needs improvement.'
          };

          await run(
            'INSERT INTO feedback(order_id, rating, comment, created_at) VALUES(?, ?, ?, ?)',
            [orderInsert.lastID, rating, comments[rating], toSqlDateTime(new Date(orderDate.getTime() + randomInt(2, 6) * 60 * 60 * 1000))]
          );
          insertedFeedback += 1;
        }
      }
    }
    await run('COMMIT');
  } catch (err) {
    await run('ROLLBACK');
    throw err;
  }

  return {
    inserted_customers: insertedCustomers,
    inserted_orders: insertedOrders,
    inserted_feedback: insertedFeedback
  };
}

async function handleIncomingWhatsApp({ from, name, text, source = 'whatsapp' }) {
  if (!from) throw new Error('from is required.');

  const parsedOrderItems = parseOrderText(text);
  if (parsedOrderItems) {
    const order = await createOrder({ phone: from, name, source, items: parsedOrderItems });

    await sendWhatsAppMessage(
      from,
      `Order #${order.orderId} confirmed. Amount with GST: Rs ${order.bill.total}. Pay using this link: ${order.payment.upiUrl}`
    );

    return { handled: true, type: 'order', orderId: order.orderId };
  }

  const parsedRating = parseRatingText(text);
  if (parsedRating) {
    const latestOrder = await get(
      `SELECT o.id
       FROM orders o
       JOIN customers c ON c.id = o.customer_id
       WHERE c.phone = ?
       ORDER BY o.id DESC LIMIT 1`,
      [from]
    );

    if (latestOrder) {
      await run('INSERT INTO feedback(order_id, rating, comment) VALUES(?, ?, ?)', [latestOrder.id, parsedRating.rating, parsedRating.comment]);
    }

    return { handled: true, type: 'rating' };
  }

  return { handled: false, message: 'No supported command found.' };
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/menu', async (_req, res) => {
  const menu = await all('SELECT * FROM menu_items WHERE is_active = 1 ORDER BY name');
  res.json(menu);
});

app.post('/api/menu/upload', async (req, res) => {
  const items = req.body.items;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'Expected items array.' });

  for (const item of items) {
    if (!item.name || Number(item.price) <= 0) continue;
    await run(
      `INSERT INTO menu_items(name, price, is_active) VALUES(?, ?, 1)
       ON CONFLICT(name) DO UPDATE SET price = excluded.price, is_active = 1`,
      [item.name.trim(), Number(item.price)]
    );
  }

  res.json({ success: true });
});

app.post('/api/menu/upload-csv', upload.single('menu'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Upload a CSV file in field name "menu".' });

  const text = req.file.buffer.toString('utf-8');
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  for (const line of lines) {
    const [name, priceRaw] = line.split(',');
    const price = Number(priceRaw);
    if (!name || !price || price <= 0) continue;

    await run(
      `INSERT INTO menu_items(name, price, is_active) VALUES(?, ?, 1)
       ON CONFLICT(name) DO UPDATE SET price = excluded.price, is_active = 1`,
      [name.trim(), price]
    );
  }

  res.json({ success: true, importedLines: lines.length });
});

app.post('/api/orders', async (req, res) => {
  try {
    const { phone, name, source = 'web', items = [] } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone is required.' });

    const order = await createOrder({ phone, name, source, items });

    await sendWhatsAppMessage(
      phone,
      `Order #${order.orderId} received. Total: Rs ${order.bill.total}. Pay here: ${order.payment.upiUrl}`
    );

    res.json(order);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/orders', async (_req, res) => {
  const orders = await all(
    `SELECT o.*, c.phone, c.name
     FROM orders o
     JOIN customers c ON c.id = o.customer_id
     ORDER BY o.id DESC`
  );

  for (const order of orders) {
    order.items = await all(
      `SELECT oi.quantity, oi.unit_price, oi.line_total, m.name
       FROM order_items oi
       JOIN menu_items m ON m.id = oi.menu_item_id
       WHERE oi.order_id = ?`,
      [order.id]
    );
  }

  res.json(orders);
});

app.get('/api/customers', async (_req, res) => {
  const customers = await all(
    `SELECT
      c.id,
      c.phone,
      c.name,
      c.created_at,
      COUNT(DISTINCT o.id) AS order_count,
      COALESCE(SUM(o.total), 0) AS total_spent,
      MAX(o.created_at) AS last_order_at
     FROM customers c
     LEFT JOIN orders o ON o.customer_id = c.id
     GROUP BY c.id, c.phone, c.name, c.created_at
     ORDER BY last_order_at DESC, c.id DESC`
  );
  res.json(customers);
});

app.get('/api/feedback', async (_req, res) => {
  const rows = await all(
    `SELECT
      f.id,
      f.order_id,
      f.rating,
      f.comment,
      f.created_at,
      c.phone,
      c.name
     FROM feedback f
     JOIN orders o ON o.id = f.order_id
     JOIN customers c ON c.id = o.customer_id
     ORDER BY f.id DESC`
  );
  res.json(rows);
});

app.get('/api/offers', async (_req, res) => {
  const rows = await all('SELECT * FROM offers ORDER BY id DESC');
  res.json(rows);
});

app.get('/api/menu-sales', async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 3650);
  const since = `-${days} days`;

  const rows = await all(
    `SELECT
      m.id,
      m.name,
      SUM(oi.quantity) AS qty_sold,
      ROUND(SUM(oi.line_total), 2) AS revenue,
      COUNT(DISTINCT oi.order_id) AS order_count,
      ROUND(AVG(oi.unit_price), 2) AS avg_unit_price
     FROM order_items oi
     JOIN menu_items m ON m.id = oi.menu_item_id
     JOIN orders o ON o.id = oi.order_id
     WHERE o.created_at >= datetime('now', ?)
     GROUP BY m.id, m.name
     ORDER BY revenue DESC, qty_sold DESC`,
    [since]
  );

  res.json({ days, items: rows });
});

app.get('/api/analytics', async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 3650);
  const since = `-${days} days`;

  const [
    periodOrders,
    totalCustomers,
    activeCustomers,
    returningActiveCustomers,
    repeatCustomers,
    ratings,
    ratingDistribution,
    dailyTrend,
    hourlyTrend,
    sourceBreakdown,
    topItems
  ] = await Promise.all([
    get(
      `SELECT
        COUNT(*) AS orders,
        COALESCE(SUM(total), 0) AS revenue,
        COALESCE(AVG(total), 0) AS avg_order_value,
        COALESCE(SUM(gst_amount), 0) AS gst_collected,
        COUNT(CASE WHEN status = 'DELIVERED' THEN 1 END) AS delivered_orders,
        COUNT(CASE WHEN status != 'DELIVERED' THEN 1 END) AS pending_orders
       FROM orders
       WHERE created_at >= datetime('now', ?)`,
      [since]
    ),
    get('SELECT COUNT(*) AS count FROM customers'),
    get(
      `SELECT COUNT(DISTINCT customer_id) AS count
       FROM orders
       WHERE created_at >= datetime('now', ?)`,
      [since]
    ),
    get(
      `SELECT COUNT(DISTINCT o.customer_id) AS count
       FROM orders o
       JOIN customers c ON c.id = o.customer_id
       WHERE o.created_at >= datetime('now', ?)
         AND c.created_at < datetime('now', ?)`,
      [since, since]
    ),
    get(
      `SELECT COUNT(*) AS count FROM (
        SELECT customer_id
        FROM orders
        GROUP BY customer_id
        HAVING COUNT(*) > 1
      )`
    ),
    get(
      `SELECT
        ROUND(AVG(f.rating), 2) AS avg_rating,
        COUNT(*) AS rating_count
       FROM feedback f
       JOIN orders o ON o.id = f.order_id
       WHERE o.created_at >= datetime('now', ?)`,
      [since]
    ),
    all(
      `SELECT rating, COUNT(*) AS count
       FROM feedback f
       JOIN orders o ON o.id = f.order_id
       WHERE o.created_at >= datetime('now', ?)
       GROUP BY rating
       ORDER BY rating DESC`,
      [since]
    ),
    all(
      `SELECT
        date(created_at) AS day,
        COUNT(*) AS orders,
        ROUND(SUM(total), 2) AS revenue
       FROM orders
       WHERE created_at >= datetime('now', ?)
       GROUP BY date(created_at)
       ORDER BY day ASC`,
      [since]
    ),
    all(
      `SELECT
        strftime('%H', created_at) AS hour,
        COUNT(*) AS orders
       FROM orders
       WHERE created_at >= datetime('now', ?)
       GROUP BY strftime('%H', created_at)
       ORDER BY hour ASC`,
      [since]
    ),
    all(
      `SELECT source, COUNT(*) AS count
       FROM orders
       WHERE created_at >= datetime('now', ?)
       GROUP BY source
       ORDER BY count DESC`,
      [since]
    ),
    all(
      `SELECT
        m.name,
        SUM(oi.quantity) AS qty_sold,
        ROUND(SUM(oi.line_total), 2) AS revenue
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       JOIN menu_items m ON m.id = oi.menu_item_id
       WHERE o.created_at >= datetime('now', ?)
       GROUP BY m.name
       ORDER BY revenue DESC
       LIMIT 10`,
      [since]
    )
  ]);

  const orders = Number(periodOrders?.orders || 0);
  const revenue = Number(periodOrders?.revenue || 0);
  const totalCustomersCount = Number(totalCustomers?.count || 0);
  const activeCustomersCount = Number(activeCustomers?.count || 0);
  const deliveredOrdersCount = Number(periodOrders?.delivered_orders || 0);
  const ratingCount = Number(ratings?.rating_count || 0);
  const avgOrderValue = Number(periodOrders?.avg_order_value || 0);

  const arpu = totalCustomersCount > 0 ? Number((revenue / totalCustomersCount).toFixed(2)) : 0;
  const mrpu = activeCustomersCount > 0 ? Number((revenue / activeCustomersCount).toFixed(2)) : 0;
  const deliveryRate = orders > 0 ? Number(((deliveredOrdersCount / orders) * 100).toFixed(2)) : 0;
  const repeatCustomerRate = totalCustomersCount > 0
    ? Number(((Number(repeatCustomers?.count || 0) / totalCustomersCount) * 100).toFixed(2))
    : 0;
  const feedbackResponseRate = deliveredOrdersCount > 0
    ? Number(((ratingCount / deliveredOrdersCount) * 100).toFixed(2))
    : 0;
  const retentionRate = activeCustomersCount > 0
    ? Number(((Number(returningActiveCustomers?.count || 0) / activeCustomersCount) * 100).toFixed(2))
    : 0;

  res.json({
    days,
    kpis: {
      revenue,
      orders,
      avg_order_value: Number(avgOrderValue.toFixed(2)),
      gst_collected: Number(Number(periodOrders?.gst_collected || 0).toFixed(2)),
      total_customers: totalCustomersCount,
      active_customers: activeCustomersCount,
      arpu,
      mrpu,
      avg_rating: ratings?.avg_rating || null,
      rating_count: ratingCount,
      delivery_rate: deliveryRate,
      repeat_customer_rate: repeatCustomerRate,
      feedback_response_rate: feedbackResponseRate,
      retention_rate: retentionRate
    },
    rating_distribution: ratingDistribution,
    daily_trend: dailyTrend,
    hourly_trend: hourlyTrend,
    source_breakdown: sourceBreakdown,
    top_items: topItems
  });
});

app.get('/api/dashboard', async (_req, res) => {
  const [
    totalOrders,
    deliveredOrders,
    totalRevenue,
    totalCustomers,
    avgRating,
    pendingOrders
  ] = await Promise.all([
    get('SELECT COUNT(*) AS count FROM orders'),
    get(`SELECT COUNT(*) AS count FROM orders WHERE status = 'DELIVERED'`),
    get('SELECT COALESCE(SUM(total), 0) AS sum FROM orders'),
    get('SELECT COUNT(*) AS count FROM customers'),
    get('SELECT ROUND(AVG(rating), 2) AS avg FROM feedback'),
    get(`SELECT COUNT(*) AS count FROM orders WHERE status != 'DELIVERED'`)
  ]);

  const recentOrders = await all(
    `SELECT o.id, o.status, o.total, o.created_at, c.phone, c.name
     FROM orders o
     JOIN customers c ON c.id = o.customer_id
     ORDER BY o.id DESC
     LIMIT 10`
  );

  const topItems = await all(
    `SELECT m.name, SUM(oi.quantity) AS qty
     FROM order_items oi
     JOIN menu_items m ON m.id = oi.menu_item_id
     GROUP BY m.name
     ORDER BY qty DESC
     LIMIT 5`
  );

  res.json({
    metrics: {
      total_orders: totalOrders?.count || 0,
      delivered_orders: deliveredOrders?.count || 0,
      pending_orders: pendingOrders?.count || 0,
      total_revenue: Number(totalRevenue?.sum || 0),
      total_customers: totalCustomers?.count || 0,
      avg_rating: avgRating?.avg || null
    },
    recent_orders: recentOrders,
    top_items: topItems
  });
});

app.post('/api/demo/seed', async (req, res) => {
  try {
    const customerCount = Math.min(Math.max(Number(req.body.customers) || 1000, 1), 5000);
    const reset = Boolean(req.body.reset);
    const result = await seedDemoData({ customerCount, reset });

    res.json({
      success: true,
      ...result
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/orders/:id/delivered', async (req, res) => {
  const orderId = Number(req.params.id);
  const order = await get(
    `SELECT o.*, c.phone
     FROM orders o JOIN customers c ON c.id = o.customer_id
     WHERE o.id = ?`,
    [orderId]
  );
  if (!order) return res.status(404).json({ error: 'Order not found.' });

  await run("UPDATE orders SET status = 'DELIVERED', delivered_at = CURRENT_TIMESTAMP WHERE id = ?", [orderId]);

  await sendWhatsAppMessage(
    order.phone,
    `Your order #${orderId} was delivered. Please reply: RATING:5 Great food`
  );

  res.json({ success: true });
});

app.post('/api/orders/:id/rating', async (req, res) => {
  const orderId = Number(req.params.id);
  const rating = Number(req.body.rating);
  const comment = req.body.comment || null;

  if (rating < 1 || rating > 5) return res.status(400).json({ error: 'rating must be 1..5' });

  await run('INSERT INTO feedback(order_id, rating, comment) VALUES(?, ?, ?)', [orderId, rating, comment]);
  res.json({ success: true });
});

app.post('/api/offers/send', async (req, res) => {
  const { title, message } = req.body;
  if (!title || !message) return res.status(400).json({ error: 'title and message are required.' });

  await run('INSERT INTO offers(title, message) VALUES(?, ?)', [title, message]);

  const customers = await all(
    `SELECT DISTINCT c.phone
     FROM customers c
     JOIN orders o ON o.customer_id = c.id`
  );

  let sent = 0;
  for (const customer of customers) {
    const resp = await sendWhatsAppMessage(customer.phone, `Daily Offer: ${title}\n${message}`);
    if (resp.success) sent += 1;
  }

  res.json({ success: true, recipients: customers.length, sent });
});

// Generic JSON webhook for local testing
app.post('/api/whatsapp/webhook', async (req, res) => {
  try {
    const result = await handleIncomingWhatsApp({
      from: req.body.from,
      name: req.body.name || null,
      text: req.body.text || '',
      source: 'whatsapp-generic'
    });

    return res.json(result);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

// Twilio inbound webhook (application/x-www-form-urlencoded)
app.post('/api/whatsapp/webhook/twilio', bodyParser.urlencoded({ extended: false }), async (req, res) => {
  try {
    const inbound = extractTwilioInbound(req.body);
    if (!inbound) return res.status(400).type('text/plain').send('Invalid Twilio payload');

    await handleIncomingWhatsApp({ ...inbound, source: 'whatsapp-twilio' });
    return res.type('text/plain').send('OK');
  } catch (err) {
    return res.status(400).type('text/plain').send(err.message);
  }
});

// Meta verification endpoint
app.get('/api/whatsapp/webhook/meta', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_META_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

// Meta inbound webhook (application/json)
app.post('/api/whatsapp/webhook/meta', async (req, res) => {
  try {
    const inbound = extractMetaInbound(req.body);
    if (!inbound) return res.json({ handled: false, message: 'No supported message in payload.' });

    await handleIncomingWhatsApp({ ...inbound, source: 'whatsapp-meta' });
    return res.sendStatus(200);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

async function start() {
  await initializeDatabase();
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
  });
}

start();
