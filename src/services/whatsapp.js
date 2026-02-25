function normalizePhoneForProvider(raw, provider) {
  if (!raw) return raw;
  const value = String(raw).trim();

  if (provider === 'twilio') {
    return value.startsWith('whatsapp:') ? value : `whatsapp:${value}`;
  }

  return value.replace(/^whatsapp:/i, '');
}

async function sendViaTwilio(to, body) {
  const accountSid = process.env.WHATSAPP_TWILIO_ACCOUNT_SID;
  const authToken = process.env.WHATSAPP_TWILIO_AUTH_TOKEN;
  const from = process.env.WHATSAPP_TWILIO_FROM;

  if (!accountSid || !authToken || !from) {
    return { success: false, provider: 'twilio', error: 'Missing Twilio env vars.' };
  }

  const form = new URLSearchParams();
  form.append('To', normalizePhoneForProvider(to, 'twilio'));
  form.append('From', normalizePhoneForProvider(from, 'twilio'));
  form.append('Body', body);

  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: form.toString()
  });

  const data = await response.json();
  if (!response.ok) {
    return { success: false, provider: 'twilio', error: data.message || 'Twilio send failed.', data };
  }

  return { success: true, provider: 'twilio', id: data.sid };
}

async function sendViaMeta(to, body) {
  const token = process.env.WHATSAPP_META_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_META_PHONE_NUMBER_ID;

  if (!token || !phoneNumberId) {
    return { success: false, provider: 'meta', error: 'Missing Meta env vars.' };
  }

  const url = `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: normalizePhoneForProvider(to, 'meta'),
      type: 'text',
      text: { body }
    })
  });

  const data = await response.json();
  if (!response.ok) {
    return { success: false, provider: 'meta', error: data.error?.message || 'Meta send failed.', data };
  }

  return { success: true, provider: 'meta', id: data.messages?.[0]?.id || null };
}

async function sendWhatsAppMessage(to, body) {
  const provider = (process.env.WHATSAPP_PROVIDER || 'mock').toLowerCase();

  if (provider === 'mock') {
    console.log(`[WhatsApp MOCK] To: ${to} | Message: ${body}`);
    return { success: true, provider: 'mock' };
  }

  if (provider === 'twilio') {
    return sendViaTwilio(to, body);
  }

  if (provider === 'meta') {
    return sendViaMeta(to, body);
  }

  return { success: false, provider, error: `Unsupported provider: ${provider}` };
}

function parseOrderText(text) {
  if (!text) return null;
  const normalized = text.trim();
  if (!normalized.toUpperCase().startsWith('ORDER:')) return null;

  const body = normalized.slice(6).trim();
  if (!body) return null;

  // Format example: ORDER: Veg Biryani x2, Butter Naan x4
  const parts = body.split(',').map((p) => p.trim()).filter(Boolean);
  const items = [];

  for (const part of parts) {
    const match = part.match(/^(.*)\sx(\d+)$/i);
    if (!match) continue;
    items.push({ name: match[1].trim(), quantity: Number(match[2]) });
  }

  return items.length ? items : null;
}

function parseRatingText(text) {
  if (!text) return null;
  const match = text.trim().match(/^RATING\s*:\s*([1-5])(?:\s*[-|,]?\s*(.*))?$/i);
  if (!match) return null;
  return { rating: Number(match[1]), comment: (match[2] || '').trim() || null };
}

function extractTwilioInbound(payload) {
  if (!payload?.From || !payload?.Body) return null;
  return {
    from: String(payload.From).replace(/^whatsapp:/i, ''),
    name: payload.ProfileName || null,
    text: payload.Body
  };
}

function extractMetaInbound(payload) {
  const value = payload?.entry?.[0]?.changes?.[0]?.value;
  const msg = value?.messages?.[0];
  if (!msg) return null;

  const from = msg.from;
  const name = value?.contacts?.[0]?.profile?.name || null;

  let text = '';
  if (msg.type === 'text') text = msg.text?.body || '';
  if (msg.type === 'button') text = msg.button?.text || '';

  if (!from || !text) return null;
  return { from, name, text };
}

module.exports = {
  sendWhatsAppMessage,
  parseOrderText,
  parseRatingText,
  extractTwilioInbound,
  extractMetaInbound
};
