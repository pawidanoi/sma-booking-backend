// One-time migration script — NOT an API route (deliberately outside backend/api/,
// since Vercel auto-deploys every file under api/ as a public unauthenticated endpoint).
//
// Reads the 460-record historical dataset embedded in the old static dashboard
// (แดชบอร์ดผู้บริหาร-เว็บ.html's `const DATA = [...]`) and upserts it into the new
// booking_legacy_summary table, so the live dashboard can merge historical + live
// data without ever importing fake per-guest rows into the real `bookings` table
// (the old data never tracked individual guest names — that was problem #1 this
// whole system exists to fix).
//
// Run locally, once:
//   cd backend
//   npm install
//   SUPABASE_URL=https://xxxxx.supabase.co SUPABASE_SERVICE_ROLE_KEY=xxxx node scripts/seed-legacy-dashboard.js
//
// Safe to re-run — upserts on `id`, so a second run just overwrites the same rows.

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('ต้องตั้ง SUPABASE_URL และ SUPABASE_SERVICE_ROLE_KEY เป็น env var ก่อนรันสคริปต์นี้');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const DASHBOARD_HTML_PATH = path.join(__dirname, '..', '..', 'แดชบอร์ดผู้บริหาร-เว็บ.html');

const MONTH_TO_START = {
  'มี.ค. 69': '2026-03-01',
  'เม.ย. 69': '2026-04-01',
  'พ.ค. 69': '2026-05-01',
  'มิ.ย. 69': '2026-06-01',
  'ก.ค. 69': '2026-07-01'
};

function extractData(html) {
  const match = html.match(/const DATA\s*=\s*(\[.*?\]);/s);
  if (!match) throw new Error('ไม่พบ const DATA = [...] ในไฟล์แดชบอร์ดเก่า');
  return JSON.parse(match[1]);
}

function toRow(rec) {
  const monthStart = MONTH_TO_START[rec.month];
  if (!monthStart) throw new Error(`ไม่รู้จักเดือน "${rec.month}" สำหรับ record ${rec.id}`);
  return {
    id: rec.id,
    month_label: rec.month,
    month_start: monthStart,
    src: rec.src,
    team_code: rec.team,
    branch_code: rec.branch_code || null,
    branch_name: rec.branch || null,
    hotel_name: rec.hotel || null,
    checkin_date: rec.checkin || null,
    checkout_date: rec.checkout || null,
    nights: rec.nights ?? null,
    rooms: rec.rooms ?? null,
    people: rec.people ?? null,
    male: rec.male ?? null,
    female: rec.female ?? null,
    capacity: rec.capacity ?? null,
    empty_beds: rec.empty_beds ?? null,
    price_per_room_night: rec.price_per_room_night ?? null,
    total_cost: rec.total_cost ?? null,
    person_nights: rec.person_nights ?? null,
    baht_per_person_night: rec.baht_per_person_night ?? null,
    empty_bed_cost: rec.empty_bed_cost ?? null,
    date_status: rec.date_status || null,
    needs_manual_fix: !!rec.needs_manual_fix
  };
}

async function main() {
  const html = fs.readFileSync(DASHBOARD_HTML_PATH, 'utf8');
  const records = extractData(html);
  console.log(`อ่านข้อมูลเก่าได้ ${records.length} รายการ`);

  const rows = records.map(toRow);
  const CHUNK = 200;
  let done = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error } = await supabase.from('booking_legacy_summary').upsert(chunk, { onConflict: 'id' });
    if (error) {
      console.error(`upsert ล้มเหลวที่ chunk เริ่ม index ${i}:`, error.message);
      process.exit(1);
    }
    done += chunk.length;
    console.log(`upsert แล้ว ${done}/${rows.length}`);
  }
  console.log('เสร็จสมบูรณ์ — booking_legacy_summary มีข้อมูลครบแล้ว');
}

main().catch((err) => {
  console.error('สคริปต์ล้มเหลว:', err);
  process.exit(1);
});
