const { supabase } = require('../lib/supabase');
const { fail } = require('../lib/http');

const BUCKET = 'vouchers';
const SIGNED_URL_TTL_SECONDS = 3600;

// GET /api/voucher-redirect?booking_id=BK69-0461
//
// The vouchers bucket is private (may contain guest/hotel details in the document
// itself), so there's no stable public URL to store — this endpoint looks up the
// storage path and mints a fresh 1-hour signed URL on every call, then redirects.
// This one link (not the signed URL itself) is what's safe to embed permanently
// anywhere — the web UI, a LINE quick-reply button, etc.
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return fail(res, 405, 'method not allowed');

  const bookingId = (req.query.booking_id || '').trim();
  if (!bookingId) return fail(res, 400, 'ไม่ได้ระบุการจอง');

  const { data: booking } = await supabase
    .from('bookings')
    .select('voucher_storage_path')
    .eq('id', bookingId)
    .maybeSingle();

  if (!booking || !booking.voucher_storage_path) {
    return fail(res, 404, 'ไม่พบไฟล์วอเชอร์สำหรับการจองนี้');
  }

  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(booking.voucher_storage_path, SIGNED_URL_TTL_SECONDS);
  if (error || !data) return fail(res, 500, (error && error.message) || 'สร้างลิงก์ดูวอเชอร์ไม่สำเร็จ');

  res.writeHead(302, { Location: data.signedUrl });
  res.end();
};
