const { supabase } = require('../lib/supabase');
const { json, fail } = require('../lib/http');
const { getActor, isDashboardViewer } = require('../lib/auth');
const { decorate, BOOKING_SELECT } = require('./bookings');

// Live data only exists from August 2026 onward — the legacy summary table covers
// everything before that. Kept as a constant, not derived, so a stray live booking
// with a wrong date can never silently double-count into both sources.
const LIVE_PERIOD_START = '2026-08-01';

// GET /api/dashboard-summary?actor=CODE&from=2026-03-01&to=2026-08-31
//
// Gated on isDashboardViewer (ผู้บริหาร/แอดมิน/the two named manager titles) — NOT
// isAdmin, which excludes ผู้บริหาร (the actual target audience for this dashboard).
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return fail(res, 405, 'method not allowed');

  const actorCode = (req.query.actor || '').trim();
  const actor = await getActor(actorCode);
  if (!actor) return fail(res, 401, 'ไม่พบรหัสพนักงานผู้ใช้งาน — เข้าสู่ระบบอีกครั้ง');
  if (!isDashboardViewer(actor)) return fail(res, 403, 'เฉพาะผู้บริหาร/แอดมินเท่านั้น');

  try {
    const from = req.query.from || '2026-03-01';
    const to = req.query.to || '2099-12-31';

    const legacyQ = supabase
      .from('booking_legacy_summary')
      .select('*')
      .gte('month_start', from)
      .lte('month_start', to);

    const liveQ = supabase
      .from('bookings')
      .select(BOOKING_SELECT)
      .eq('status', 'จองสำเร็จ')
      .gte('checkin_date', LIVE_PERIOD_START)
      .gte('checkin_date', from)
      .lte('checkin_date', to);

    const [{ data: legacyRows, error: legacyErr }, { data: liveRowsRaw, error: liveErr }] = await Promise.all([legacyQ, liveQ]);
    if (legacyErr) return fail(res, 500, legacyErr.message);
    if (liveErr) return fail(res, 500, liveErr.message);

    // Map screen (dashboard, "booking นี้" pins): the one home location shown per
    // booking is the requester's — same convention the home-distance-rule already
    // uses in bookings.js, not an attempt to average every guest's address.
    const requesterCodes = [...new Set((liveRowsRaw || []).map((r) => r.created_by_employee).filter(Boolean))];
    const { data: empRows } = requesterCodes.length
      ? await supabase.from('employees').select('code, home_lat, home_lng').in('code', requesterCodes)
      : { data: [] };
    const homeByCode = new Map((empRows || []).map((e) => [e.code, e]));

    const liveRecords = (liveRowsRaw || []).map((row) => toLiveRecord(row, homeByCode));
    const legacyRecords = (legacyRows || []).map(toLegacyRecord);
    const records = [...legacyRecords, ...liveRecords].sort((a, b) => (a.month_start < b.month_start ? -1 : 1));

    const kpis = computeKpis(records, legacyRows || [], liveRowsRaw || []);
    const monthly_trend = groupBy(records, (r) => r.month_start, (rows, key) => ({
      month_start: key,
      month_label: rows[0].month_label,
      total_cost: sum(rows, 'total_cost'),
      person_nights: sum(rows, 'person_nights')
    }));
    const src_split = {
      SMA: { total_cost: sum(records.filter((r) => r.src === 'SMA'), 'total_cost'), count: records.filter((r) => r.src === 'SMA').length },
      AREA: { total_cost: sum(records.filter((r) => r.src === 'AREA'), 'total_cost'), count: records.filter((r) => r.src === 'AREA').length }
    };
    const cost_per_person_night_trend = monthly_trend.map((m) => ({
      month_start: m.month_start,
      month_label: m.month_label,
      value: m.person_nights > 0 ? Math.round((m.total_cost / m.person_nights) * 100) / 100 : 0
    }));
    const team_cost = groupBy(records, (r) => r.team_code || '—', (rows, key) => ({
      team_code: key,
      total_cost: sum(rows, 'total_cost')
    })).sort((a, b) => b.total_cost - a.total_cost);
    const top_hotels = groupBy(records, (r) => r.hotel_name || '—', (rows, key) => ({
      hotel_name: key,
      total_cost: sum(rows, 'total_cost')
    })).sort((a, b) => b.total_cost - a.total_cost).slice(0, 10);

    json(res, 200, { records, kpis, monthly_trend, src_split, cost_per_person_night_trend, team_cost, top_hotels });
  } catch (err) {
    console.error('dashboard-summary error', err);
    fail(res, 500, err.message || 'เกิดข้อผิดพลาดในระบบ');
  }
};

function toLegacyRecord(r) {
  return {
    id: r.id,
    month_label: r.month_label,
    month_start: r.month_start,
    src: r.src,
    team_code: r.team_code,
    branch_name: r.branch_name,
    hotel_name: r.hotel_name,
    nights: r.nights,
    rooms: r.rooms,
    people: r.people,
    empty_beds: r.empty_beds,
    total_cost: Number(r.total_cost) || 0,
    person_nights: r.person_nights || 0,
    baht_per_person_night: Number(r.baht_per_person_night) || 0,
    empty_bed_cost: Number(r.empty_bed_cost) || 0,
    needs_manual_fix: !!r.needs_manual_fix,
    booking_id: null,
    branch_lat: null, branch_lng: null, hotel_lat: null, hotel_lng: null, home_lat: null, home_lng: null
  };
}

function toLiveRecord(row, homeByCode) {
  const b = decorate(row);
  const monthStart = (b.checkin_date || '').slice(0, 7) + '-01';
  const chosen = (b.booking_hotel_choices || []).find((c) => c.id === b.chosen_hotel_choice_id) || null;
  const pricePerRoomNight = chosen ? (chosen.custom_price ?? (chosen.hotels && chosen.hotels.default_price_per_night) ?? 0) : 0;
  // A room sleeps 2, so an unfilled bed wastes half the room's nightly rate — same
  // definition the legacy dataset uses (verified against its embedded sample rows).
  const emptyBedCost = (pricePerRoomNight / 2) * b.derived.empty_beds * b.derived.nights;
  const personNights = b.derived.people * b.derived.nights;
  const home = homeByCode ? homeByCode.get(b.created_by_employee) : null;
  const numOrNull = (v) => (v == null ? null : Number(v));
  return {
    id: b.id,
    month_label: monthLabelFromDate(b.checkin_date),
    month_start: monthStart,
    src: b.team_code === 'AREA' ? 'AREA' : 'SMA',
    team_code: b.team_code,
    branch_name: b.branches ? b.branches.name : b.branch_code,
    hotel_name: chosen ? (chosen.hotels ? chosen.hotels.name : chosen.custom_name) : null,
    nights: b.derived.nights,
    rooms: b.derived.rooms,
    people: b.derived.people,
    empty_beds: b.derived.empty_beds,
    total_cost: b.derived.est_total,
    person_nights: personNights,
    baht_per_person_night: personNights > 0 ? b.derived.est_total / personNights : 0,
    empty_bed_cost: emptyBedCost,
    needs_manual_fix: false,
    booking_id: b.id,
    branch_lat: numOrNull(b.branches && b.branches.lat),
    branch_lng: numOrNull(b.branches && b.branches.lng),
    hotel_lat: numOrNull(chosen && chosen.hotels && chosen.hotels.lat),
    hotel_lng: numOrNull(chosen && chosen.hotels && chosen.hotels.lng),
    home_lat: numOrNull(home && home.home_lat),
    home_lng: numOrNull(home && home.home_lng)
  };
}

const THAI_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
function monthLabelFromDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  const shortBe = String(d.getFullYear() + 543).slice(-2);
  return `${THAI_MONTHS[d.getMonth()]} ${shortBe}`;
}

function sum(rows, key) {
  return rows.reduce((a, r) => a + (Number(r[key]) || 0), 0);
}

function groupBy(rows, keyFn, mapFn) {
  const groups = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return Array.from(groups.entries()).map(([key, groupRows]) => mapFn(groupRows, key));
}

function computeKpis(records, legacyRows, liveRows) {
  const total_cost = sum(records, 'total_cost');
  const empty_bed_cost = sum(records, 'empty_bed_cost');
  const total_person_nights = sum(records, 'person_nights');
  return {
    total_cost,
    empty_bed_cost,
    empty_bed_cost_pct: total_cost > 0 ? Math.round((empty_bed_cost / total_cost) * 1000) / 10 : 0,
    booking_count: records.length,
    // Weighted by real person-nights — NOT an average of each record's own per-record average.
    avg_baht_per_person_night: total_person_nights > 0 ? Math.round((total_cost / total_person_nights) * 100) / 100 : 0,
    total_person_nights,
    // Two separate counts, not one guessed merge — see dashboard-summary design notes:
    // legacy "needs_manual_fix" is a paper-era data-quality artifact; live bookings can
    // never have it (date pickers enforce valid dates from day one). The live-period
    // equivalent of "needs attention" is bookings currently stuck in ติดปัญหา/ต้องแก้ไข.
    needs_fix_count_legacy: legacyRows.filter((r) => r.needs_manual_fix).length,
    live_needs_attention_count: 0 // populated by a separate lightweight query if the dashboard needs it later
  };
}
