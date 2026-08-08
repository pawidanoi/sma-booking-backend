const { getActor } = require('../lib/auth');
const { json, fail } = require('../lib/http');
const { drivingDistance } = require('../lib/directions');

// GET /api/directions?actor=CODE&from_lat=..&from_lng=..&to_lat=..&to_lng=..
//
// Employee-facing check — backs the map feature's home-distance-rule
// (สรุป-requirement-แผนที่จองที่พัก.md §3: <10km from home to branch warns the
// employee to go home instead of booking) shown right after branch selection,
// and any screen that shows real driving distance/time between two points. Any
// logged-in employee can call this — not admin-gated, since the rule fires in
// the employee's own booking form before an admin is ever involved. The
// authoritative recheck at booking creation lives in bookings.js, which calls
// the same lib/directions.js helper server-side rather than trusting this
// endpoint's response back from the client.
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return fail(res, 405, 'method not allowed');

  const actor = await getActor(req.query.actor);
  if (!actor) return fail(res, 401, 'ไม่พบรหัสพนักงานผู้ใช้งาน — เข้าสู่ระบบอีกครั้ง');

  const fromLat = Number(req.query.from_lat);
  const fromLng = Number(req.query.from_lng);
  const toLat = Number(req.query.to_lat);
  const toLng = Number(req.query.to_lng);
  if (![fromLat, fromLng, toLat, toLng].every(Number.isFinite)) {
    return fail(res, 400, 'พิกัดไม่ครบหรือไม่ถูกต้อง');
  }

  const result = await drivingDistance(fromLat, fromLng, toLat, toLng);
  if (!result) return fail(res, 502, 'คำนวณระยะทางไม่สำเร็จ — ตรวจสอบ ORS_API_KEY หรือลองใหม่');

  return json(res, 200, result);
};
