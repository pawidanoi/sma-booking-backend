const { supabase } = require('../lib/supabase');
const { json, fail } = require('../lib/http');

// One call that the web app makes right after the employee enters their code.
// Returns who they are, what they're allowed to see, and every reference list
// the booking form needs — so the form never has to hit the network again.
//
// GET /api/bootstrap?code=CMT2400114
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return fail(res, 405, 'method not allowed');

  const code = (req.query.code || '').trim();
  if (!code) return fail(res, 400, 'กรุณาใส่รหัสพนักงาน');

  const { data: me, error: meErr } = await supabase
    .from('employees')
    .select('code, name, nickname, team_code, gender, phone, position, receives_notify, active')
    .eq('code', code)
    .maybeSingle();

  if (meErr) return fail(res, 500, meErr.message);
  if (!me) return fail(res, 404, 'ไม่พบรหัสพนักงานนี้ในทะเบียน — ตรวจตัวสะกดอีกครั้ง หรือติดต่อแอดมิน');
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
    schedule: scheduleRes.data || []
  });
};
