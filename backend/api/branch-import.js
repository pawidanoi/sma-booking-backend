const { supabase } = require('../lib/supabase');
const { json, fail, readBody } = require('../lib/http');
const { getActor, isAdmin } = require('../lib/auth');

// Syncs the branches registry from CJ Mart's official store-master Excel file
// (parsed client-side in index.html, this endpoint just receives the rows).
// Upsert-by-code: adds new branches and refreshes name/district/province/lat/lng
// for existing ones, never deletes — a branch that drops out of a later export
// might still be referenced by existing schedule/bookings/hotels-near-branch data.
//
// POST /api/branch-import  body: { actor, rows: [{code, name, district, province, lat, lng}] }
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return fail(res, 405, 'method not allowed');

  const body = readBody(req);
  const actor = await getActor(body.actor);
  if (!actor) return fail(res, 401, 'ไม่พบรหัสพนักงานผู้ใช้งาน');
  if (!isAdmin(actor)) return fail(res, 403, 'เฉพาะแอดมินเท่านั้น');

  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (rows.length === 0) return fail(res, 400, 'ไม่พบแถวข้อมูลในไฟล์');

  const valid = [];
  const skipped = [];
  rows.forEach((row, i) => {
    const code = String(row.code || '').trim();
    const name = String(row.name || '').trim();
    const lat = Number(row.lat);
    const lng = Number(row.lng);
    const reasons = [];
    if (!code) reasons.push('ไม่มีรหัสสาขา');
    if (!name) reasons.push('ไม่มีชื่อสาขา');
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) reasons.push('พิกัดไม่ถูกต้อง (ดึงจากลิงก์ Google Maps ไม่ได้)');

    if (reasons.length) { skipped.push({ row: i + 2, code, reasons }); return; }
    valid.push({ code, name, district: row.district || null, province: row.province || null, lat, lng });
  });

  let upserted = 0;
  if (valid.length > 0) {
    const { error } = await supabase.from('branches').upsert(valid, { onConflict: 'code' });
    if (error) return fail(res, 500, error.message);
    upserted = valid.length;
  }

  return json(res, 200, { ok: true, upserted, skipped: skipped.length, skipped_detail: skipped });
};
