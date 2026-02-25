const QRCode = require('qrcode');

async function generatePaymentQR({ amount, orderId }) {
  const upiId = process.env.PAYMENT_UPI_ID || 'your-upi-id@bank';
  const name = encodeURIComponent(process.env.PAYMENT_NAME || 'Hotel Payment');
  const note = encodeURIComponent(`Order ${orderId}`);
  const upiUrl = `upi://pay?pa=${upiId}&pn=${name}&am=${amount}&tn=${note}&cu=INR`;
  const qrDataUrl = await QRCode.toDataURL(upiUrl);

  return { upiUrl, qrDataUrl };
}

module.exports = { generatePaymentQR };
