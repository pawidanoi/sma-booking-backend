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

module.exports = { getActor, ADMIN_POSITIONS, SELF_SERVE_POSITIONS, isAdmin, isDashboardViewer };
