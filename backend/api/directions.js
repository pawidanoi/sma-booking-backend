const { getActor } = require('../lib/auth');
const { json, fail } = require('../lib/http');

// GET /api/directions?actor=CODE&from_lat=..&from_lng=..&to_lat=..&to_lng=..
//
// Server-side proxy to OpenRouteService (free tier, no card needed — chosen over
// Google Directions for that reason) so ORS_API_KEY never reaches the browser,
// same reasoning as SUPABASE_SERVICE_ROLE_KEY staying server-only. Backs the map
// feature's home-distance-rule (สรุป-requirement-แผนที่จองที่พัก.md §3: <10km from
// home to branch warns the employee to go home instead of booking) and any
// screen that shows real driving distance/time between two points. Any logged-in
// employee can call this — not admin-gated, since the rule fires in the
// employee's own booking form before an admin is ever involved.
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

  const apiKey = process.env.ORS_API_KEY;
  if (!apiKey) return fail(res, 500, 'ยังไม่ได้ตั้งค่า ORS_API_KEY ใน Vercel');

  const url = `https://api.openrouteservice.org/v2/directions/driving-car?api_key=${encodeURIComponent(apiKey)}&start=${fromLng},${fromLat}&end=${toLng},${toLat}`;

  try {
    const orsRes = await fetch(url);
    const data = await orsRes.json();
    if (!orsRes.ok) {
      return fail(res, 502, data?.error?.message || 'คำนวณระยะทางไม่สำเร็จ');
    }
    const summary = data?.features?.[0]?.properties?.summary;
    if (!summary) return fail(res, 502, 'ไม่พบข้อมูลระยะทางจาก OpenRouteService');

    return json(res, 200, {
      distance_km: Math.round((summary.distance / 1000) * 10) / 10,
      duration_min: Math.round(summary.duration / 60)
    });
  } catch (err) {
    return fail(res, 502, 'เชื่อมต่อ OpenRouteService ไม่สำเร็จ: ' + err.message);
  }
};
