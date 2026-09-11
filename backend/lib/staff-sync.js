// ซิงค์ชื่อ/ชื่อเล่น/เพศ/ทีม/เบอร์โทรพนักงานอัตโนมัติจากชีต HR (Google Sheets, เปิดดูสาธารณะ)
// เฉพาะพนักงานที่มีรหัสอยู่ในทะเบียน employees อยู่แล้วเท่านั้น — รหัสใหม่ในชีตที่ยังไม่เคยมี
// ในระบบจะถูกข้าม ไม่สร้างพนักงานใหม่อัตโนมัติ (การสร้างพนักงานใหม่ยังคงเป็นสิ่งที่แอดมินต้องกด
// เองผ่าน employee_create เสมอ)
//
// "ไม่แตะ" position (ตัวกำหนดสิทธิ์ AREA/HQ/แอดมิน — คงไว้ตามที่ระบบตั้งไว้เดิมเสมอ), active,
// line_user_id, home_lat/home_lng, receives_notify — เป็นข้อมูลที่ระบบนี้ดูแลเอง ไม่ได้มาจาก HR
// และ bank_name/bank_account_no/bank_account_name — ข้อมูลอ่อนไหวระดับ 🔴 ตามนโยบายข้อมูล
// ห้ามงานอัตโนมัติเขียนทับเด็ดขาด
const { supabase } = require('./supabase');

const SHEET_ID = '1ME9-ibHGGdo94RjbXA2v69NKbF_27x87TCu2vGGlLzo';
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=0`;

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { field += c; }
    } else if (c === '"') { inQuotes = true; }
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* skip */ }
    else { field += c; }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function norm(s) { const v = (s || '').trim(); return v ? v : null; }

// ชื่อเล่นในชีตมีเพศต่อท้าย เช่น "ออย ญ" / "แบงค์ ช" — แยกออกมา ต้องจับ ญ/ช แบบเป็นคำเดี่ยวๆ
// กลางสตริงได้ ไม่ใช่แค่ตัวท้ายสุดของทั้งสตริง ไม่งั้นเพศจะหายเป็น null
function splitNicknameGender(raw) {
  const s = norm(raw);
  if (!s) return { nickname: null, gender: null };
  const m = s.match(/^(.*?)\s+(ญ|ช)(?:\s|$)/);
  if (m) return { nickname: m[1].trim() || null, gender: m[2] === 'ญ' ? 'F' : 'M' };
  return { nickname: s, gender: null };
}

// คอลัมน์ชีต: รหัสพนักงาน, ชื่อพนักงาน, ทีมปัจจุบัน, Area, ชื่อเล่น, เบอร์โทร, ที่อยู่
async function syncStaffFromSheet() {
  const res = await fetch(SHEET_URL);
  if (!res.ok) throw new Error(`ดึงชีต HR ไม่สำเร็จ (HTTP ${res.status})`);
  const csv = await res.text();
  const rows = parseCsv(csv);
  const dataRows = rows.slice(1).filter((r) => norm(r[0]));

  const sheetRows = dataRows.map((r) => {
    const [code, name, team, , nicknameRaw, phone] = r;
    const { nickname, gender } = splitNicknameGender(nicknameRaw);
    return { code: norm(code), name: norm(name), team_code: norm(team), nickname, gender, phone: norm(phone) };
  }).filter((r) => r.code && r.name);

  if (!sheetRows.length) throw new Error('อ่านชีต HR ได้แต่ไม่พบแถวข้อมูล (ตรวจรูปแบบคอลัมน์)');

  const { data: existing, error: exErr } = await supabase.from('employees').select('code');
  if (exErr) throw new Error('อ่านทะเบียนพนักงานเดิมไม่สำเร็จ: ' + exErr.message);
  const existingCodes = new Set((existing || []).map((r) => r.code));

  const updates = sheetRows.filter((r) => existingCodes.has(r.code));
  const skippedNew = sheetRows.length - updates.length;

  // แถวว่างในชีต (เช่น ยังไม่กรอกชื่อเล่น) ไม่ควรลบข้อมูลเดิมในระบบทิ้ง — sync ทับเฉพาะฟิลด์
  // ที่ชีตมีค่าจริงเท่านั้น ส่วน name เป็นคอลัมน์บังคับอยู่แล้วจากการ filter ด้านบน
  for (const r of updates) {
    const patch = { name: r.name };
    if (r.team_code) patch.team_code = r.team_code;
    if (r.nickname) patch.nickname = r.nickname;
    if (r.gender) patch.gender = r.gender;
    if (r.phone) patch.phone = r.phone;
    const { error } = await supabase.from('employees').update(patch).eq('code', r.code);
    if (error) throw new Error(`อัพเดตพนักงาน ${r.code} ไม่สำเร็จ: ${error.message}`);
  }

  return { updated: updates.length, skippedNew, syncedAt: new Date().toISOString() };
}

module.exports = { syncStaffFromSheet, parseCsv, splitNicknameGender };
