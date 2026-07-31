const { supabase } = require('./supabase');

// Shared by the chat-based "ผูกบัญชี" flow (line-webhook.js) and bootstrap.js's
// LIFF auto-login lookup. employees.line_user_id is UNIQUE (schema.sql) — one
// LINE account maps to exactly one employee, so re-linking clears any previous
// owner first.
async function linkEmployeeByCode(code, lineUserId) {
  const trimmedCode = (code || '').trim();
  if (!trimmedCode) return { ok: false, error: 'กรุณาใส่รหัสพนักงาน' };
  if (!lineUserId) return { ok: false, error: 'ไม่พบ LINE user id' };

  const { data: employee, error: findErr } = await supabase
    .from('employees')
    .select('code, name, nickname, active')
    .eq('code', trimmedCode)
    .maybeSingle();

  if (findErr) return { ok: false, error: findErr.message };
  if (!employee) return { ok: false, error: 'ไม่พบรหัสพนักงานนี้ในทะเบียนนะคะ พิมพ์ใหม่อีกครั้ง หรือติดต่อแอดมิน' };
  if (employee.active === false) return { ok: false, error: 'บัญชีนี้ถูกปิดใช้งานแล้ว ติดต่อแอดมิน' };

  const { error: clearErr } = await supabase.from('employees').update({ line_user_id: null }).eq('line_user_id', lineUserId);
  if (clearErr) return { ok: false, error: clearErr.message };

  const { error: linkErr } = await supabase.from('employees').update({ line_user_id: lineUserId }).eq('code', trimmedCode);
  if (linkErr) return { ok: false, error: linkErr.message };

  return { ok: true, employee };
}

module.exports = { linkEmployeeByCode };
