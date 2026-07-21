const required = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY'];
const missing = required.filter((name) => !String(process.env[name] || '').trim());

if (missing.length > 0) {
  console.error(`Missing production Web build variables: ${missing.join(', ')}`);
  process.exit(1);
}

let supabaseUrl;
try {
  supabaseUrl = new URL(String(process.env.VITE_SUPABASE_URL));
} catch {
  console.error('VITE_SUPABASE_URL must be an absolute HTTPS URL.');
  process.exit(1);
}

if (supabaseUrl.protocol !== 'https:' || !supabaseUrl.hostname.endsWith('.supabase.co')) {
  console.error('VITE_SUPABASE_URL must use https://<project-ref>.supabase.co.');
  process.exit(1);
}

const configuredApiUrl = String(process.env.VITE_API_BASE_URL || '').trim();
if (configuredApiUrl) {
  try {
    const apiUrl = new URL(configuredApiUrl);
    if (apiUrl.protocol !== 'https:') throw new Error('not https');
  } catch {
    console.error('VITE_API_BASE_URL must be blank for same-origin or an absolute HTTPS URL.');
    process.exit(1);
  }
}

console.log('Production Web build variables are present and structurally valid.');
