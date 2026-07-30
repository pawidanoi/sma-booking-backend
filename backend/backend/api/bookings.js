const { supabase } = require('../lib/supabase');
const { json, fail, readBody, roomsFor, nightsBetween } = require('../lib/http');

const ADMIN_POSITIONS = ['แอดมิน'];
const SELF_SERVE_POSITIONS = [
  'ผู้บริหาร',
  'แอดมิน',
  'Sales & Marketing Division Manager',
  'หัวหน้าแผนกกิจกรรมร้านค้า'
];

const BOOKING_SELECT = `
  id, team_code, branch_code, work_schedule_id, checkin_date, checkout_date, status,
  reject_reason, chosen_hotel_choice_id, confirmation_no, voucher_file_url, note,
  created_by_employee, created_at, updated_at,
  branches ( name, province, lat, lng ),
  booking_hotel_choices ( id, hotel_id, custom_name, custom_map_link, custom_price, rank, hotels ( code, name, province, lat, lng, default_price_per_night, on_choowap ) ),
  booking_guests ( id, team_code, employee_code, name, phone, gender ),
  booking_changes ( id, type, new_rooms, new_checkin, new_checkout, note, status, created_at )
`;

async function getActor(code) {
  if (!code) return null;
  const { data } = await supabase
    .from('employees')
    .select('code, name, nickname, team_code, position')
    .eq('code', code)
    .maybeSingle();
  return data;
}

module.exports = async function handler(req, res) {
  const body = readBody(req);
  const actorCode = (req.query.actor || body.actor || '').trim();
  const actor = await getActor(actorCode);
  if (!actor) return fail(res, 401, 'ไม่พบรหัสพนักงานผู้ใช้งาน — เข้าสู่ระบบอีกครั้ง');

  const isAdmin = ADMIN_POSITIONS.includes(actor.position);

  try {
    if (req.method === 'GET') return await listBookings(req, res, actor, isAdmin);
    if (req.method === 'POST') return await handlePost(req, res, actor, isAdmin, body);
    if (req.method === 'PATCH') return await handlePatch(req, res, actor, isAdmin, body);
    return fail(res, 405, 'method not allowed');
  } catch (err) {
    console.error('bookings handler error', err);
    return fail(res, 500, err.message || 'เกิดข้อผิดพลาดในระบบ');
  }
};

// ---------------------------------------------------------------- read

async function listBookings(req, res, actor, isAdmin) {
  const scope = req.query.scope || 'mine';
  let q = supabase.from('bookings').select(BOOKING_SELECT).order('created_at', { ascending: false });

  if (scope === 'admin') {
    if (!isAdmin) return fail(res, 403, 'เฉพาะแอดมินเท่านั้น');
  } else {
    // An employee sees what they submitted plus anything else their team submitted,
    // so a stand-in can pick up a booking the usual booker started.
    q = q.or(`created_by_employee.eq.${actor.code},team_code.eq.${actor.team_code}`);
  }

  const { data, error } = await q;
  if (error) return fail(res, 500, error.message);
  json(res, 200, { bookings: (data || []).map(decorate) });
}

function decorate(b) {
  const guests = b.booking_guests || [];
  const rooms = roomsFor(guests);
  const nights = nightsBetween(b.checkin_date, b.checkout_date);
  const chosen = (b.booking_hotel_choices || []).find((c) => c.id === b.chosen_hotel_choice_id) || null;
  const pricePerNight = chosen ? (chosen.custom_price ?? chosen.hotels?.default_price_per_night ?? 0) : 0;
  return {
    ...b,
    derived: {
      rooms,
      nights,
      people: guests.length,
      male: guests.filter((g) => g.gender === 'M').length,
      female: guests.filter((g) => g.gender === 'F').length,
      capacity: rooms * 2,
      empty_beds: rooms * 2 - guests.length,
      est_total: pricePerNight * rooms * nights
    }
  };
}

// ---------------------------------------------------------------- create / change request

async function handlePost(req, res, actor, isAdmin, body) {
  const action = body.action || 'create';
  if (action === 'create') return createBooking(req, res, actor, body);
  if (action === 'request_change') return requestChange(req, res, actor, body);
  return fail(res, 400, `ไม่รู้จัก action: ${action}`);
}

async function nextBookingId() {
  const { data } = await supabase
    .from('bookings')
    .select('id')
    .like('id', 'BK69-%')
    .order('id', { ascending: false })
    .limit(1);
  const last = data && data[0] ? parseInt(String(data[0].id).replace('BK69-', ''), 10) : 460;
  return `BK69-${String((isNaN(last) ? 460 : last) + 1).padStart(4, '0')}`;
}

async function createBooking(req, res, actor, body) {
  const { branch_code, work_schedule_id, checkin_date, checkout_date, note, guests, hotel_choices } = body;

  if (!branch_code) return fail(res, 400, 'ยังไม่ได้เลือกสาขา');
  if (!checkin_date || !checkout_date) return fail(res, 400, 'ยังไม่ได้เลือกวันเข้าพัก–วันออก');
  if (new Date(checkout_date) <= new Date(checkin_date)) return fail(res, 400, 'วันออกต้องหลังวันเข้าพัก');
  if (!Array.isArray(guests) || guests.length === 0) return fail(res, 400, 'ยังไม่ได้กรอกผู้เข้าพัก');
  if (!Array.isArray(hotel_choices) || hotel_choices.length === 0) return fail(res, 400, 'ยังไม่ได้เลือกที่พัก');
  if (hotel_choices.length > 3) return fail(res, 400, 'เลือกที่พักได้สูงสุด 3 ที่');

  for (const g of guests) {
    if (!g.name || !String(g.name).trim()) return fail(res, 400, 'ผู้เข้าพักบางคนยังไม่มีชื่อ');
    if (g.gender !== 'M' && g.gender !== 'F') return fail(res, 400, 'ผู้เข้าพักบางคนยังไม่ระบุเพศ');
  }

  // Rule: warn when the same person is already booked on overlapping dates.
  const conflicts = await findGuestConflicts(guests, checkin_date, checkout_date);

  const id = await nextBookingId();
  const { error: insErr } = await supabase.from('bookings').insert({
    id,
    team_code: actor.team_code,
    branch_code,
    work_schedule_id: work_schedule_id || null,
    checkin_date,
    checkout_date,
    status: 'ส่งคำขอ',
    note: note || null,
    created_by_employee: actor.code
  });
  if (insErr) return fail(res, 500, insErr.message);

  const guestRows = guests.map((g) => ({
    booking_id: id,
    team_code: g.team_code || actor.team_code,
    employee_code: g.employee_code || null,
    name: String(g.name).trim(),
    phone: g.phone || null,
    gender: g.gender
  }));
  const { error: gErr } = await supabase.from('booking_guests').insert(guestRows);
  if (gErr) {
    await supabase.from('bookings').delete().eq('id', id);
    return fail(res, 500, `บันทึกผู้เข้าพักไม่สำเร็จ: ${gErr.message}`);
  }

  const choiceRows = hotel_choices.map((c, i) => ({
    booking_id: id,
    hotel_id: c.hotel_id || null,
    custom_name: c.custom_name || null,
    custom_map_link: c.custom_map_link || null,
    custom_price: c.custom_price ?? null,
    rank: i + 1
  }));
  const { error: cErr } = await supabase.from('booking_hotel_choices').insert(choiceRows);
  if (cErr) {
    await supabase.from('bookings').delete().eq('id', id);
    return fail(res, 500, `บันทึกที่พักที่เลือกไม่สำเร็จ: ${cErr.message}`);
  }

  const { data: fresh } = await supabase.from('bookings').select(BOOKING_SELECT).eq('id', id).maybeSingle();
  json(res, 201, { booking: fresh ? decorate(fresh) : null, warnings: conflicts });
}

async function findGuestConflicts(guests, newCheckin, newCheckout) {
  const codes = guests.map((g) => g.employee_code).filter(Boolean);
  if (codes.length === 0) return [];
  const { data } = await supabase
    .from('booking_guests')
    .select('name, employee_code, bookings!inner ( id, checkin_date, checkout_date, status )')
    .in('employee_code', codes);

  const from = new Date(newCheckin).getTime();
  const to = new Date(newCheckout).getTime();
  const out = [];
  for (const row of data || []) {
    const b = row.bookings;
    // A rejected booking isn't holding a room, so it can't be a real clash.
    if (!b || b.status === 'ต้องแก้ไข') continue;
    const bFrom = new Date(b.checkin_date).getTime();
    const bTo = new Date(b.checkout_date).getTime();
    if (bFrom < to && bTo > from) {
      out.push(`${row.name} มีการจองซ้อนวันอยู่แล้ว (${b.id}: ${b.checkin_date} – ${b.checkout_date})`);
    }
  }
  return out;
}

async function requestChange(req, res, actor, body) {
  const { booking_id, type, new_rooms, new_checkin, new_checkout, note } = body;
  const allowed = ['ลดจำนวนห้อง', 'ลดจำนวนคืน', 'ขอย้ายที่พัก', 'ยกเลิกการจอง'];
  if (!allowed.includes(type)) return fail(res, 400, 'ประเภทเรื่องแจ้งไม่ถูกต้อง');

  const { data: bk } = await supabase.from('bookings').select('id, status').eq('id', booking_id).maybeSingle();
  if (!bk) return fail(res, 404, 'ไม่พบการจองนี้');
  // Confirmed rule: employees may only raise a change once the admin has started booking.
  if (bk.status === 'ส่งคำขอ') return fail(res, 400, 'รอแอดมินเริ่มดำเนินการจองก่อน ถึงจะขอเปลี่ยนแปลงได้');

  const { error } = await supabase.from('booking_changes').insert({
    booking_id,
    type,
    new_rooms: new_rooms ?? null,
    new_checkin: new_checkin || null,
    new_checkout: new_checkout || null,
    note: note || null,
    status: 'pending'
  });
  if (error) return fail(res, 500, error.message);
  json(res, 201, { ok: true });
}

// ---------------------------------------------------------------- admin actions

async function handlePatch(req, res, actor, isAdmin, body) {
  const { booking_id, action } = body;
  if (!booking_id) return fail(res, 400, 'ไม่ได้ระบุการจอง');

  const { data: bk } = await supabase.from('bookings').select('id, status').eq('id', booking_id).maybeSingle();
  if (!bk) return fail(res, 404, 'ไม่พบการจองนี้');

  const adminOnly = ['start_processing', 'choose_hotel', 'attach_voucher', 'reject', 'mark_problem', 'accept_change', 'dismiss_change', 'cancel_booking'];
  if (adminOnly.includes(action) && !isAdmin) return fail(res, 403, 'เฉพาะแอดมินเท่านั้น');

  const stamp = { updated_at: new Date().toISOString() };

  if (action === 'start_processing') {
    const { error } = await supabase.from('bookings').update({ status: 'ดำเนินการจอง', ...stamp }).eq('id', booking_id);
    if (error) return fail(res, 500, error.message);
    return await respondFresh(res, booking_id);
  }

  if (action === 'choose_hotel') {
    const { choice_id } = body;
    if (!choice_id) return fail(res, 400, 'ไม่ได้เลือกที่พัก');
    const { error } = await supabase.from('bookings').update({ chosen_hotel_choice_id: choice_id, ...stamp }).eq('id', booking_id);
    if (error) return fail(res, 500, error.message);
    return await respondFresh(res, booking_id);
  }

  if (action === 'attach_voucher') {
    const { confirmation_no, voucher_file_url } = body;
    // Confirmed rule: a booking cannot reach จองสำเร็จ without the Choowap confirmation number.
    if (!confirmation_no || !String(confirmation_no).trim()) return fail(res, 400, 'ต้องกรอกเลขยืนยันจากชูวับก่อน');
    const { error } = await supabase
      .from('bookings')
      .update({ status: 'จองสำเร็จ', confirmation_no: String(confirmation_no).trim(), voucher_file_url: voucher_file_url || null, ...stamp })
      .eq('id', booking_id);
    if (error) return fail(res, 500, error.message);
    return await respondFresh(res, booking_id);
  }

  if (action === 'reject') {
    const { reason } = body;
    if (!reason || !String(reason).trim()) return fail(res, 400, 'ต้องกรอกเหตุผลที่ส่งกลับให้แก้ไข');
    const { error } = await supabase
      .from('bookings')
      .update({ status: 'ต้องแก้ไข', reject_reason: String(reason).trim(), ...stamp })
      .eq('id', booking_id);
    if (error) return fail(res, 500, error.message);
    return await respondFresh(res, booking_id);
  }

  if (action === 'mark_problem') {
    const { error } = await supabase.from('bookings').update({ status: 'ติดปัญหา', ...stamp }).eq('id', booking_id);
    if (error) return fail(res, 500, error.message);
    return await respondFresh(res, booking_id);
  }

  if (action === 'accept_change' || action === 'dismiss_change') {
    const { change_id } = body;
    if (!change_id) return fail(res, 400, 'ไม่ได้ระบุเรื่องแจ้ง');
    const { data: ch } = await supabase.from('booking_changes').select('*').eq('id', change_id).maybeSingle();
    if (!ch) return fail(res, 404, 'ไม่พบเรื่องแจ้งนี้');

    if (action === 'accept_change') {
      if (ch.type === 'ลดจำนวนคืน' && ch.new_checkin && ch.new_checkout) {
        const { error } = await supabase
          .from('bookings')
          .update({ checkin_date: ch.new_checkin, checkout_date: ch.new_checkout, ...stamp })
          .eq('id', booking_id);
        if (error) return fail(res, 500, error.message);
      }
      await supabase.from('booking_changes').update({ status: 'accepted' }).eq('id', change_id);
    } else {
      await supabase.from('booking_changes').update({ status: 'dismissed' }).eq('id', change_id);
    }
    return await respondFresh(res, booking_id);
  }

  if (action === 'cancel_booking') {
    const { error } = await supabase.from('bookings').delete().eq('id', booking_id);
    if (error) return fail(res, 500, error.message);
    return json(res, 200, { deleted: true });
  }

  if (action === 'edit') {
    // Employee resubmitting after a reject: replace guests + hotel choices wholesale.
    const { checkin_date, checkout_date, note, guests, hotel_choices, branch_code } = body;
    if (!checkin_date || !checkout_date) return fail(res, 400, 'ยังไม่ได้เลือกวันเข้าพัก–วันออก');
    if (new Date(checkout_date) <= new Date(checkin_date)) return fail(res, 400, 'วันออกต้องหลังวันเข้าพัก');
    if (!Array.isArray(guests) || guests.length === 0) return fail(res, 400, 'ยังไม่ได้กรอกผู้เข้าพัก');
    if (!Array.isArray(hotel_choices) || hotel_choices.length === 0) return fail(res, 400, 'ยังไม่ได้เลือกที่พัก');

    const { error: upErr } = await supabase
      .from('bookings')
      .update({
        checkin_date,
        checkout_date,
        note: note || null,
        branch_code: branch_code || undefined,
        status: 'ส่งคำขอ',
        reject_reason: null,
        chosen_hotel_choice_id: null,
        ...stamp
      })
      .eq('id', booking_id);
    if (upErr) return fail(res, 500, upErr.message);

    await supabase.from('booking_guests').delete().eq('booking_id', booking_id);
    await supabase.from('booking_hotel_choices').delete().eq('booking_id', booking_id);

    await supabase.from('booking_guests').insert(
      guests.map((g) => ({
        booking_id,
        team_code: g.team_code || actor.team_code,
        employee_code: g.employee_code || null,
        name: String(g.name).trim(),
        phone: g.phone || null,
        gender: g.gender
      }))
    );
    await supabase.from('booking_hotel_choices').insert(
      hotel_choices.map((c, i) => ({
        booking_id,
        hotel_id: c.hotel_id || null,
        custom_name: c.custom_name || null,
        custom_map_link: c.custom_map_link || null,
        custom_price: c.custom_price ?? null,
        rank: i + 1
      }))
    );
    return await respondFresh(res, booking_id);
  }

  return fail(res, 400, `ไม่รู้จัก action: ${action}`);
}

async function respondFresh(res, id) {
  const { data } = await supabase.from('bookings').select(BOOKING_SELECT).eq('id', id).maybeSingle();
  json(res, 200, { booking: data ? decorate(data) : null });
}

module.exports.SELF_SERVE_POSITIONS = SELF_SERVE_POSITIONS;
