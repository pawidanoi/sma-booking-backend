/**
 * Google Apps Script — ดึงข้อมูลการจองสดจากระบบมาแสดงในชีต (อ่านอย่างเดียว)
 * Postgres เป็นฐานข้อมูลจริง ชีตนี้แค่มิเรอร์ไว้ให้หัวหน้าเปิดดูได้ตลอดไม่ต้อง login
 *
 * วิธีติดตั้ง:
 * 1. สร้าง Google Sheet ใหม่ (ชีตไหนก็ได้ แนะนำตั้งชื่อ "การจองสด SMA")
 * 2. เมนู Extensions > Apps Script > วางโค้ดนี้ทั้งไฟล์
 * 3. Project Settings > Script Properties > เพิ่ม key SHEET_EXPORT_TOKEN
 *    ค่าจาก Vercel Dashboard > Settings > Environment Variables
 * 4. รันฟังก์ชัน createTrigger ครั้งเดียว (ตั้งให้ดึงข้อมูลทุก 30 นาที)
 * 5. ทดสอบด้วยการรัน pullLiveBookings เองครั้งหนึ่งดูว่าขึ้นข้อมูลไหม
 */

const ENDPOINT_URL = 'https://sma-booking-backend.vercel.app/api/live-export';
const SHEET_NAME = 'การจองสด';

function createTrigger() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'pullLiveBookings')
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('pullLiveBookings').timeBased().everyMinutes(30).create();
  Logger.log('ตั้ง trigger ทุก 30 นาทีเรียบร้อย');
}

function pullLiveBookings() {
  const token = PropertiesService.getScriptProperties().getProperty('SHEET_EXPORT_TOKEN');
  if (!token) throw new Error('ยังไม่ได้ตั้งค่า SHEET_EXPORT_TOKEN ใน Script Properties');

  const response = UrlFetchApp.fetch(ENDPOINT_URL, {
    headers: { 'X-Export-Token': token },
    muteHttpExceptions: true
  });
  if (response.getResponseCode() !== 200) {
    throw new Error('ดึงข้อมูลไม่สำเร็จ HTTP ' + response.getResponseCode() + ': ' + response.getContentText());
  }

  const { rows } = JSON.parse(response.getContentText());
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  sheet.clear();

  const headers = ['เลขที่', 'ทีม', 'สาขา', 'เช็คอิน', 'เช็คเอาท์', 'คืน', 'สถานะ', 'คน', 'ชาย', 'หญิง', 'ห้อง', 'ที่พัก', 'ประมาณการ', 'เลขยืนยัน', 'ผู้เข้าพัก', 'อนุมัติอัตโนมัติ', 'สร้างเมื่อ'];
  const data = rows.map((r) => [
    r.id, r.team, r.branch, r.checkin, r.checkout, r.nights, r.status, r.people, r.male, r.female,
    r.rooms, r.hotel, r.est_total, r.confirmation_no, r.guests, r.auto_approved ? 'ใช่' : '', r.created_at
  ]);

  sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  if (data.length) sheet.getRange(2, 1, data.length, headers.length).setValues(data);
  sheet.setFrozenRows(1);
  Logger.log('ดึงมา ' + rows.length + ' รายการ');
}
