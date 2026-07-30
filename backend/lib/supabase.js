const { createClient } = require('@supabase/supabase-js');

// SUPABASE_SERVICE_ROLE_KEY (not the anon key) — this backend runs server-side only
// and needs to bypass row-level security to write bookings/schedule/employees.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = { supabase };
