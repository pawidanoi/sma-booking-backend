const { supabase } = require('../lib/supabase');

// Called by the Apps Script trigger (~every 30 min) with the full contents of
// the "แผนงาน" sheet for whichever date range it covers.
// Strategy (agreed in HANDOFF): full-replace-by-range — delete existing
// source='sheet_sync' rows inside [minDate, maxDate] from the payload, then
// insert everything fresh. The sheet is the source of truth for that range.
// Rows referencing an unknown team_code/branch_code are skipped and reported
// back — never silently dropped.
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).end(); return; }

  const token = req.headers['x-sync-token'];
  if (!token || token !== process.env.SCHEDULE_SYNC_TOKEN) {
    res.status(401).json({ error: 'invalid sync token' });
    return;
  }

  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (rows.length === 0) {
    res.status(400).json({ error: 'no rows provided' });
    return;
  }

  const { data: teams } = await supabase.from('teams').select('code');
  const { data: branches } = await supabase.from('branches').select('code');
  const teamCodes = new Set((teams || []).map((t) => t.code));
  const branchCodes = new Set((branches || []).map((b) => b.code));

  const valid = [];
  const skipped = [];

  for (const row of rows) {
    const { team_code, branch_code, date_start, date_end, advance_days } = row;
    const reasons = [];
    if (!teamCodes.has(team_code)) reasons.push(`ไม่พบทีม ${team_code}`);
    if (!branchCodes.has(branch_code)) reasons.push(`ไม่พบสาขา ${branch_code}`);
    if (!date_start || !date_end) reasons.push('วันที่ไม่ครบ');
    if (date_start && date_end && date_end <= date_start) reasons.push('วันจบต้องหลังวันเริ่ม');

    if (reasons.length) {
      skipped.push({ row, reasons });
      continue;
    }
    valid.push({
      team_code,
      branch_code,
      date_start,
      date_end,
      advance_days: Number.isInteger(advance_days) && advance_days >= 0 && advance_days <= 14 ? advance_days : 0,
      source: 'sheet_sync'
    });
  }

  if (valid.length > 0) {
    const minDate = valid.reduce((m, r) => (r.date_start < m ? r.date_start : m), valid[0].date_start);
    const maxDate = valid.reduce((m, r) => (r.date_end > m ? r.date_end : m), valid[0].date_end);

    const { error: delErr } = await supabase
      .from('work_schedule')
      .delete()
      .eq('source', 'sheet_sync')
      .gte('date_start', minDate)
      .lte('date_end', maxDate);
    if (delErr) { res.status(500).json({ error: delErr.message }); return; }

    const { error: insErr } = await supabase.from('work_schedule').insert(valid);
    if (insErr) { res.status(500).json({ error: insErr.message }); return; }
  }

  res.status(200).json({
    inserted: valid.length,
    skipped: skipped.length,
    skipped_detail: skipped
  });
};
