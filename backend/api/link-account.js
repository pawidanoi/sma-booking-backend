const { supabase } = require('../lib/supabase');
const { json, fail, readBody } = require('../lib/http');

// Called from the /link-account LIFF page. Body: { code, line_user_id }.
// employees.line_user_id has a UNIQUE constraint (schema.sql) — one LINE account
// maps to exactly one employee, so re-linking clears any previous owner first.
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return fail(res, 405, 'method not allowed');

  const body = readBody(req);
  const code = (body.code || '').trim();
  const lineUserId = (body.line_user_id || '').trim();
  if (!code) return fail(res, 400, 'กรุณาใส่รหัสพนักงาน');
  if (!lineUserId) return fail(res, 400, 'ไม่พบ LINE user id — เปิดผ่าน LINE เท่านั้น');

  const { data: employee, error: findErr } = await supabase
    .from('employees')
    .select('code, name, nickname, active')
    .eq('code', code)
    .maybeSingle();

  if (findErr) return fail(res, 500, findErr.message);
  if (!employee) return fail(res, 404, 'ไม่พบรหัสพนักงานนี้ในทะเบียน — ตรวจตัวสะกดอีกครั้ง หรือติดต่อแอดมิน');
  if (employee.active === false) return fail(res, 403, 'บัญชีนี้ถูกปิดใช้งานแล้ว ติดต่อแอดมิน');

  // Clear this LINE account from whichever employee row (if any) held it before.
  const { error: clearErr } = await supabase
    .from('employees')
    .update({ line_user_id: null })
    .eq('line_user_id', lineUserId);
  if (clearErr) return fail(res, 500, clearErr.message);

  const { error: linkErr } = await supabase
    .from('employees')
    .update({ line_user_id: lineUserId })
    .eq('code', code);
  if (linkErr) return fail(res, 500, linkErr.message);

  return json(res, 200, { ok: true, name: employee.nickname || employee.name });
};
