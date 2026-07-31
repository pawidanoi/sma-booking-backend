const { supabase } = require('../lib/supabase');
const { json, fail, readBody } = require('../lib/http');
const { getActor, isAdmin: checkIsAdmin } = require('../lib/auth');

// booking_deposit_claims has two FK columns pointing at employees (claimed_by_employee,
// reviewed_by_employee) — same ambiguity trap that bit bookings<->booking_hotel_choices,
// so we deliberately never nest employees(...) here. The frontend already has the full
// staff code->name map from bootstrap and resolves names client-side instead.
const CLAIM_SELECT = `
  id, booking_id, claimed_by_employee, amount, bank_account_no, bank_name, bank_account_name,
  note, status, reviewed_by_employee, reviewed_at, returned_at, created_at, updated_at,
  bookings ( id, branch_code, checkin_date, checkout_date, team_code, status )
`;

module.exports = async function handler(req, res) {
  const body = readBody(req);
  const actorCode = (req.query.actor || body.actor || '').trim();
  const actor = await getActor(actorCode);
  if (!actor) return fail(res, 401, 'ไม่พบรหัสพนักงานผู้ใช้งาน — เข้าสู่ระบบอีกครั้ง');

  const isAdmin = checkIsAdmin(actor);

  try {
    if (req.method === 'GET') return await listClaims(req, res, actor, isAdmin);
    if (req.method === 'POST') return await createClaim(req, res, actor, body);
    if (req.method === 'PATCH') return await handlePatch(req, res, actor, isAdmin, body);
    return fail(res, 405, 'method not allowed');
  } catch (err) {
    console.error('deposit-claims handler error', err);
    return fail(res, 500, err.message || 'เกิดข้อผิดพลาดในระบบ');
  }
};

async function listClaims(req, res, actor, isAdmin) {
  const scope = req.query.scope || 'mine';
  let q = supabase.from('booking_deposit_claims').select(CLAIM_SELECT).order('created_at', { ascending: false });

  if (scope === 'admin') {
    if (!isAdmin) return fail(res, 403, 'เฉพาะแอดมินเท่านั้น');
  } else {
    q = q.eq('claimed_by_employee', actor.code);
  }

  const { data, error } = await q;
  if (error) return fail(res, 500, error.message);
  json(res, 200, { claims: data || [] });
}

async function createClaim(req, res, actor, body) {
  const { booking_id, amount, bank_account_no, bank_name, bank_account_name, note } = body;

  if (!booking_id) return fail(res, 400, 'ไม่ได้ระบุการจอง');
  const numAmount = Number(amount);
  if (!numAmount || numAmount <= 0) return fail(res, 400, 'กรอกจำนวนเงินให้ถูกต้อง');
  if (!bank_account_no || !String(bank_account_no).trim()) return fail(res, 400, 'กรอกเลขบัญชีก่อน');

  const { data: bk } = await supabase.from('bookings').select('id').eq('id', booking_id).maybeSingle();
  if (!bk) return fail(res, 404, 'ไม่พบการจองนี้');

  const { data, error } = await supabase
    .from('booking_deposit_claims')
    .insert({
      booking_id,
      claimed_by_employee: actor.code,
      amount: numAmount,
      bank_account_no: String(bank_account_no).trim(),
      bank_name: bank_name || null,
      bank_account_name: bank_account_name || null,
      note: note || null,
      status: 'รอตรวจ'
    })
    .select(CLAIM_SELECT)
    .maybeSingle();
  if (error) return fail(res, 500, error.message);
  json(res, 201, { claim: data });
}

async function handlePatch(req, res, actor, isAdmin, body) {
  const { claim_id, action } = body;
  if (!claim_id) return fail(res, 400, 'ไม่ได้ระบุคำขอเบิก');
  if (!isAdmin) return fail(res, 403, 'เฉพาะแอดมินเท่านั้น');

  const { data: claim } = await supabase.from('booking_deposit_claims').select('*').eq('id', claim_id).maybeSingle();
  if (!claim) return fail(res, 404, 'ไม่พบคำขอนี้');

  const stamp = { updated_at: new Date().toISOString() };

  if (action === 'accept') {
    if (claim.status !== 'รอตรวจ') return fail(res, 400, 'สถานะไม่ถูกต้อง — คำขอนี้ผ่านการตรวจไปแล้ว');
    const { error } = await supabase
      .from('booking_deposit_claims')
      .update({ status: 'อนุมัติแต่ยังไม่คืน', reviewed_by_employee: actor.code, reviewed_at: new Date().toISOString(), ...stamp })
      .eq('id', claim_id);
    if (error) return fail(res, 500, error.message);
    return await respondFresh(res, claim_id);
  }

  if (action === 'mark_returned') {
    if (claim.status !== 'อนุมัติแต่ยังไม่คืน') return fail(res, 400, 'สถานะไม่ถูกต้อง — ต้องอนุมัติก่อนถึงจะคืนเงินได้');
    const { error } = await supabase
      .from('booking_deposit_claims')
      .update({ status: 'คืนแล้ว', returned_at: new Date().toISOString(), ...stamp })
      .eq('id', claim_id);
    if (error) return fail(res, 500, error.message);
    return await respondFresh(res, claim_id);
  }

  if (action === 'delete_claim') {
    const { error } = await supabase.from('booking_deposit_claims').delete().eq('id', claim_id);
    if (error) return fail(res, 500, error.message);
    return json(res, 200, { deleted: true });
  }

  return fail(res, 400, `ไม่รู้จัก action: ${action}`);
}

async function respondFresh(res, id) {
  const { data } = await supabase.from('booking_deposit_claims').select(CLAIM_SELECT).eq('id', id).maybeSingle();
  json(res, 200, { claim: data });
}
