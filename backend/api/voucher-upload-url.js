const { supabase } = require('../lib/supabase');
const { json, fail, readBody } = require('../lib/http');
const { getActor, isAdmin: checkIsAdmin } = require('../lib/auth');

const BUCKET = 'vouchers';

// POST /api/voucher-upload-url { actor, booking_id, filename, content_type }
// Admin-only: mints a short-lived signed upload URL so the browser can push the
// file bytes straight to Supabase Storage, bypassing the Vercel function body limit
// entirely (a scanned voucher photo can easily be 1-5MB).
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return fail(res, 405, 'method not allowed');

  const body = readBody(req);
  const actorCode = (req.query.actor || body.actor || '').trim();
  const actor = await getActor(actorCode);
  if (!actor) return fail(res, 401, 'ไม่พบรหัสพนักงานผู้ใช้งาน — เข้าสู่ระบบอีกครั้ง');
  if (!checkIsAdmin(actor)) return fail(res, 403, 'เฉพาะแอดมินเท่านั้น');

  const { booking_id, filename } = body;
  if (!booking_id) return fail(res, 400, 'ไม่ได้ระบุการจอง');
  if (!filename) return fail(res, 400, 'ไม่ได้ระบุชื่อไฟล์');

  const safeName = String(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = `${booking_id}/${Date.now()}-${safeName}`;

  try {
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path);
    if (error) return fail(res, 500, error.message);
    json(res, 200, { path, token: data.token, signed_url: data.signedUrl });
  } catch (err) {
    fail(res, 500, err.message || 'สร้างลิงก์อัปโหลดไม่สำเร็จ');
  }
};
