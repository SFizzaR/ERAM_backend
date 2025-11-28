// backend/lib/supabase.js
const { createClient } = require('@supabase/supabase-js');

// Force-load the .env that is sitting next to server.js
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!supabaseUrl || !supabaseKey) {
    console.error('SUPABASE_URL or SUPABASE_ANON_KEY is missing!');
    console.error('Current SUPABASE_URL:', supabaseUrl ? 'found' : 'MISSING');
    console.error('Current SUPABASE_ANON_KEY:', supabaseKey ? 'found (length ' + supabaseKey.length + ')' : 'MISSING');
    process.exit(1); // stop the server early so you see the problem
}

const supabase = createClient(supabaseUrl, supabaseKey);

module.exports = { supabase };