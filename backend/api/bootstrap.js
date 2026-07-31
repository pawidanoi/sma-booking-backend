const { supabase } = require('../lib/supabase');
const { json, fail } = require('../lib/http');

// One call that the web app makes right after the employee is identified.
// Returns who they are, what they're allowed to see, and every reference list
// the booking form needs — so the form never has to hit the network again.
//
// GET /api/bootstrap?code=CMT2400114 — manual entry (normal browser)
// GET /api/bootstrap?line_user_id=U...  — auto-login when opened inside LIFF,
//   for an employee who already linked their account by chatting with มะม่วง
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return fail(res, 405, 'method not allowed');

  const code = (req.query.code || '').trim();
  const lineUserId = (req.query.line_user_id || '').trim();
  if (!code && !lineUserId) return fail(res, 400, 'กรุณาใส่รหัสพนักงาน');

  const lookup = supabase
    .from('employees')
    .select('code, name, nickname, team_code, gender, phone, position, receives_notify, active');
  const { data: me, error: meErr } = await (code
    ? lookup.eq('code', code)
    : lookup.eq('line_user_id', lineUserId)
  ).maybeSingle();

  if (meErr) return fail(res, 500, meErr.message);
  if (!me) {
    return fail(res, 404, code
      ? 'ไม่พบรหัสพนักงานนี้ในทะเบียน — ตรวจตัวสะกดอีกครั้ง หรือติดต่อแอดมิน'
      : 'ยังไม่เคยผูกบัญชี LINE นี้ — พิมพ์รหัสพนักงานในแชทกับมะม่วงก่อนนะ');
  }
  if (me.active === false) return fail(res, 403, 'บัญชีนี้ถูกปิดใช้งานแล้ว ติดต่อแอดมิน');

  const [branchesRes, hotelsRes, teamsRes, staffRes, scheduleRes] = await Promise.all([
    supabase.from('branches').select('code, name, district, province, lat, lng, needs_review').order('name'),
    supabase
      .from('hotels')
      .select('id, code, name, province, near_area, lat, lng, default_price_per_night, on_choowap, is_custom')
      .eq('active', true)
      .order('name'),
    supabase.from('teams').select('code, name').order('code'),
    supabase
      .from('employees')
      .select('code, name, nickname, team_code, gender, phone')
      .eq('active', true)
      .order('team_code'),
    supabase
      .from('work_schedule')
      .select('id, team_code, branch_code, date_start, date_end, advance_days')
      .order('date_start')
  ]);

  const firstError = [branchesRes, hotelsRes, teamsRes, staffRes, scheduleRes].find((r) => r.error);
  if (firstError) return fail(res, 500, firstError.error.message);

  json(res, 200, {
    me,
    branches: branchesRes.data || [],
    hotels: hotelsRes.data || [],
    teams: teamsRes.data || [],
    staff: staffRes.data || [],
    schedule: scheduleRes.data || [],
    // Keeps the frontend's mission-type options in sync with the DB CHECK constraint
    // instead of a second hardcoded copy drifting out of step.
    constants: { mission_types: ['งานแฟร์', 'งานเปิดสาขา', 'สำรวจพื้นที่', 'อื่นๆ'] }
  });
};
