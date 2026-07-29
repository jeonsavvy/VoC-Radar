import { readFile } from 'node:fs/promises';

const configUrl = new URL('../apps/worker/wrangler.toml', import.meta.url);
const config = await readFile(configUrl, 'utf8');
const workerPackage = JSON.parse(await readFile(new URL('../apps/worker/package.json', import.meta.url), 'utf8'));
const varsSection = config.match(/^\[vars\]\s*\r?\n([\s\S]*?)(?=^\[[^\]]+\]\s*$|(?![\s\S]))/m)?.[1];
const reportFlag = varsSection?.match(/^REPORT_V2_ENABLED\s*=\s*"([^"]+)"\s*$/m)?.[1];
const dailyLimit = Number(
  varsSection?.match(/^USER_JOB_DAILY_LIMIT\s*=\s*"([^"]+)"\s*$/m)?.[1],
);
const rateLimitSection = config.match(
  /^\[\[ratelimits\]\]\s*\r?\n([\s\S]*?)(?=^\[\[|^\[[^\]]+\]\s*$|(?![\s\S]))/m,
)?.[1];
const rateLimitName = rateLimitSection?.match(/^name\s*=\s*"([^"]+)"\s*$/m)?.[1];
const rateLimitNamespace = rateLimitSection?.match(/^namespace_id\s*=\s*"([^"]+)"\s*$/m)?.[1];
const rateLimitSimple = rateLimitSection?.match(
  /^simple\s*=\s*\{\s*limit\s*=\s*(\d+)\s*,\s*period\s*=\s*(\d+)\s*\}\s*$/m,
);
const limitsSection = config.match(/^\[limits\]\s*\r?\n([\s\S]*?)(?=^\[[^\]]+\]\s*$|(?![\s\S]))/m)?.[1];
const subrequestLimit = Number(limitsSection?.match(/^subrequests\s*=\s*(\d+)\s*$/m)?.[1]);

if (reportFlag !== 'false') {
  console.error('wrangler.toml must keep REPORT_V2_ENABLED=false; promote it only with an explicit deploy override.');
  process.exit(1);
}

if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 100) {
  console.error('wrangler.toml USER_JOB_DAILY_LIMIT must be an integer from 1 through 100.');
  process.exit(1);
}

if (
  rateLimitName !== 'APPLE_LOOKUP_RATE_LIMITER'
  || !/^\d+$/.test(rateLimitNamespace || '')
  || Number(rateLimitNamespace) < 1
  || Number(rateLimitSimple?.[1]) !== 10
  || Number(rateLimitSimple?.[2]) !== 60
) {
  console.error('Worker Apple lookup rate limiter must use its account-unique namespace with a 10 requests per 60 seconds policy.');
  process.exit(1);
}

if (subrequestLimit !== 50) {
  console.error('Worker subrequests must stay capped at 50 for the bounded review-fetch contract.');
  process.exit(1);
}

if (!String(workerPackage.scripts?.deploy || '').includes('wrangler deploy --keep-vars')) {
  console.error('Worker deploy script must retain dashboard-managed variables with --keep-vars.');
  process.exit(1);
}

console.log('Release config is fail-closed for the V2 report path.');
