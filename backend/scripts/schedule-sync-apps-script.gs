/**
 * Google Apps Script — ซิงก์ชีต "แผนงาน" ไปที่ /api/schedule-sync ทุก 30 นาที
 *
 * วิธีติดตั้ง:
 * 1. เปิดชีตแผนงาน (https://docs.google.com/spreadsheets/d/1MYp_l1k-uFSGBv_9OOQE_ZafM7rs5hiagBp3F2_BwDU)
 * 2. เมนู Extensions > Apps Script
 * 3. ลบโค้ดเดิมในไฟล์ Code.gs (ถ้ามี) แล้ววางไฟล์นี้ทั้งหมดแทน
 * 4. ตั้งค่า token แบบปลอดภัย (เลือกวิธีใดวิธีหนึ่ง):
 *    - แนะนำ: เมนู Project Settings (ไอคอนเฟือง) ทางซ้าย > Script Properties >
 *      Add script property > key = SCHEDULE_SYNC_TOKEN, value = <ค่าจริงจาก Vercel
 *      Dashboard > Settings > Environment Variables>
 *    - หรือรันฟังก์ชัน setupTokenOnce() ด้านล่างครั้งเดียว (ใส่ค่า token ในโค้ดชั่วคราว
 *      แล้วลบออกหลังรันเสร็จ)
 * 5. รันฟังก์ชัน createTrigger() ครั้งเดียว (เลือกจาก dropdown ด้านบนแล้วกด Run) เพื่อ
 *    ตั้งเวลาซิงก์อัตโนมัติทุก 30 นาที — ครั้งแรกจะขอ authorize สิทธิ์เข้าถึงชีต + อินเทอร์เน็ต
 * 6. ทดสอบโดยรัน syncScheduleToBooking() เองครั้งหนึ่ง ดู Logger (View > Logs) ว่าขึ้น
 *    inserted/skipped เท่าไหร่
 */

const ENDPOINT_URL = 'https://sma-booking-backend.vercel.app/api/schedule-sync';
const HEADER_ROWS = 1; // แถวที่ 1 เป็นหัวคอลัมน์

// คอลัมน์ในชีต (0-indexed): A=ทีม, B=รหัส, C=สาขา(ไม่ใช้), D=วันที่เริ่มงาน, E=วันที่จบงาน, F=เข้าพักก่อนเริ่มงาน(วัน)
const COL_TEAM = 0;
const COL_BRANCH_CODE = 1;
const COL_DATE_START = 3;
const COL_DATE_END = 4;
const COL_ADVANCE_DAYS = 5;

function setupTokenOnce() {
  const token = 'วางค่า SCHEDULE_SYNC_TOKEN จริงตรงนี้ชั่วคราวแล้วรันครั้งเดียว จากนั้นลบบรรทัดนี้ทิ้ง';
  PropertiesService.getScriptProperties().setProperty('SCHEDULE_SYNC_TOKEN', token);
  Logger.log('Token saved. ลบค่า token ออกจากบรรทัดนี้แล้ว save ไฟล์อีกครั้ง');
}

function createTrigger() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'syncScheduleToBooking')
    .forEach((t) => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('syncScheduleToBooking').timeBased().everyMinutes(30).create();
  Logger.log('ตั้ง trigger ทุก 30 นาทีเรียบร้อย');
}

function syncScheduleToBooking() {
  const token = PropertiesService.getScriptProperties().getProperty('SCHEDULE_SYNC_TOKEN');
  if (!token) {
    throw new Error('ยังไม่ได้ตั้งค่า SCHEDULE_SYNC_TOKEN ใน Script Properties — ดูขั้นตอนที่ 4 ด้านบน');
  }

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets().find((s) => s.getSheetId() === 0)
    || SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const values = sheet.getDataRange().getValues();

  const rows = [];
  for (let i = HEADER_ROWS; i < values.length; i++) {
    const row = values[i];
    const teamCode = String(row[COL_TEAM] || '').trim();
    const branchCode = String(row[COL_BRANCH_CODE] || '').trim();
    if (!teamCode || !branchCode) continue; // ข้ามแถวว่าง

    rows.push({
      team_code: teamCode,
      branch_code: branchCode,
      date_start: toIsoDate(row[COL_DATE_START], tz),
      date_end: toIsoDate(row[COL_DATE_END], tz),
      advance_days: parseAdvanceDays(row[COL_ADVANCE_DAYS])
    });
  }

  if (rows.length === 0) {
    Logger.log('ไม่พบข้อมูลแถวไหนเลย ไม่ส่งอะไรไป');
    return;
  }

  const response = UrlFetchApp.fetch(ENDPOINT_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-Sync-Token': token },
    payload: JSON.stringify({ rows: rows }),
    muteHttpExceptions: true
  });

  const status = response.getResponseCode();
  const body = response.getContentText();
  Logger.log('HTTP ' + status + ': ' + body);

  if (status !== 200) {
    throw new Error('sync ล้มเหลว HTTP ' + status + ': ' + body);
  }

  const parsed = JSON.parse(body);
  if (parsed.skipped > 0) {
    Logger.log('มีแถวที่ข้าม ' + parsed.skipped + ' แถว: ' + JSON.stringify(parsed.skipped_detail));
  }
}

// รับได้ทั้ง Date object (กรณี Sheets แปลงวันที่ให้อัตโนมัติ) และ string แบบ d/m/yyyy
function toIsoDate(cellValue, timeZone) {
  if (cellValue instanceof Date) {
    return Utilities.formatDate(cellValue, timeZone, 'yyyy-MM-dd');
  }
  const parts = String(cellValue).trim().split('/');
  if (parts.length === 3) {
    const day = parts[0].padStart(2, '0');
    const month = parts[1].padStart(2, '0');
    const year = parts[2];
    return year + '-' + month + '-' + day;
  }
  return '';
}

function parseAdvanceDays(cellValue) {
  const n = parseInt(cellValue, 10);
  return Number.isNaN(n) ? 0 : n;
}
