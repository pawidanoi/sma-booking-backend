// Shared actor lookup + permission checks — every API file that needs to know
// "who is calling, and are they allowed to do this" imports from here instead
// of re-declaring its own copy.
const { supabase } = require('./supabase');

const ADMIN_POSITIONS = ['แอดมิน'];
// Positions that get self-serve ad-hoc booking today, and are also the intended
// audience for the executive dashboard — a plain "แอดมิน" check would wrongly
// lock out real ผู้บริหาร (executives), so dashboard gating uses this list instead.
const SELF_SERVE_POSITIONS = [
  'ผู้บริหาร',
  'แอดมิน',
  'Sales & Marketing Division Manager',
  'หัวหน้าแผนกกิจกรรมร้านค้า'
];

async function getActor(code) {
  if (!code) return null;
  const { data } = await supabase
    .from('employees')
    .select('code, name, nickname, team_code, position, home_lat, home_lng')
    .eq('code', code)
    .maybeSingle();
  return data;
}

const isAdmin = (actor) => ADMIN_POSITIONS.includes(actor && actor.position);
const isDashboardViewer = (actor) => SELF_SERVE_POSITIONS.includes(actor && actor.position);

// A person's job position, checked the same way ADMIN_POSITIONS/isAdmin
// already are — distinct from teams.code === 'AREA' (an actual team that
// submits its own bookings, unrelated; see dashboard-summary.js's src_split
// and index.html's b.src field for that other meaning of "AREA").
const AREA_APPROVER_POSITION = 'ผู้ตรวจอนุมัติพื้นที่';
const isAreaApprover = (actor) => !!actor && actor.position === AREA_APPROVER_POSITION;

async function getAreaTeamCodes(employeeCode) {
  const { data } = await supabase.from('area_team_assignments').select('team_code').eq('area_employee_code', employeeCode);
  return (data || []).map((r) => r.team_code);
}

// Role check alone isn't enough authorization — an AREA approver must only
// act on bookings whose team is actually assigned to them, not any team.
async function canAreaApprove(actor, teamCode) {
  if (!isAreaApprover(actor) || !teamCode) return false;
  const teamCodes = await getAreaTeamCodes(actor.code);
  return teamCodes.includes(teamCode);
}

module.exports = {
  getActor, ADMIN_POSITIONS, SELF_SERVE_POSITIONS, isAdmin, isDashboardViewer,
  AREA_APPROVER_POSITION, isAreaApprover, getAreaTeamCodes, canAreaApprove
};
