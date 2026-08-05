const { supabase } = require('../lib/supabase');
const { json, fail, readBody } = require('../lib/http');
const { getActor, isAdmin } = require('../lib/auth');

// One-off admin-triggered set of an employee's default refund bank account
// (requested directly by the user for a specific employee code).
//
// POST /api/set-employee-bank  body: { actor, code, bank_name, bank_account_no, bank_account_name }
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return fail(res, 405, 'method not allowed');

  const body = readBody(req);
  const actor = await getActor(body.actor);
  if (!actor) return fail(res, 401, 'ไม่พบรหัสพนักงานผู้ใช้งาน');
  if (!isAdmin(actor)) return fail(res, 403, 'เฉพาะแอดมินเท่านั้น');

  const code = String(body.code || '').trim();
  if (!code) return fail(res, 400, 'ไม่ได้ระบุรหัสพนักงาน');

  const { data: employee, error: findErr } = await supabase.from('employees').select('code').eq('code', code).maybeSingle();
  if (findErr) return fail(res, 500, findErr.message);
  if (!employee) return fail(res, 404, 'ไม่พบรหัสพนักงานนี้');

  const { error } = await supabase
    .from('employees')
    .update({
      bank_name: body.bank_name || null,
      bank_account_no: body.bank_account_no || null,
      bank_account_name: body.bank_account_name || null
    })
    .eq('code', code);
  if (error) return fail(res, 500, error.message);

  return json(res, 200, { ok: true, code });
};
