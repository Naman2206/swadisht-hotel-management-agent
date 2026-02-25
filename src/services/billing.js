const GST_PERCENT = 5;

function calculateBill(items) {
  const subtotal = items.reduce((sum, item) => sum + item.lineTotal, 0);
  const gstAmount = Number(((subtotal * GST_PERCENT) / 100).toFixed(2));
  const total = Number((subtotal + gstAmount).toFixed(2));

  return {
    subtotal: Number(subtotal.toFixed(2)),
    gstPercent: GST_PERCENT,
    gstAmount,
    total
  };
}

module.exports = { calculateBill, GST_PERCENT };
