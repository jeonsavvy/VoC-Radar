const data = $json.data || {};
const status = (data.status || '').toString().trim().toLowerCase();
const jobId = (data.jobId || '').toString().trim() || null;

if (!jobId || status !== 'running') {
  return [{ json: { hasClaim: false, status: status || 'empty' } }];
}

const claimToken = (data.claimToken || '').toString().trim();
const leaseExpiresAt = (data.leaseExpiresAt || '').toString().trim();
const attemptCount = Number(data.attemptCount);
if (!claimToken || !leaseExpiresAt || !Number.isInteger(attemptCount) || attemptCount < 1) {
  throw new Error('claim response is incomplete');
}

const appStoreId = (data.appStoreId || '').toString().trim();
if (!appStoreId) {
  throw new Error('claim response missing appStoreId');
}

const country = (data.country || 'kr').toString().trim().toLowerCase();
const appName = (data.appName || '').toString().trim();
const source = (data.source || '').toString().trim().toLowerCase();
const forceReanalysis = source === 'reanalysis';
const claimKey = $('Prepare Claim Job Payload').first().json.claimKey;
const runId = 'RUN_' + jobId + '_' + attemptCount;

const rawWindowDays = ($env.VOC_FETCH_WINDOW_DAYS || '30').toString().trim();
const parsedWindowDays = Number(rawWindowDays);
const fetchWindowDays = Number.isFinite(parsedWindowDays)
  ? Math.min(Math.max(Math.floor(parsedWindowDays), 1), 90)
  : 30;

const rawMaxPages = ($env.VOC_FETCH_MAX_PAGES || '40').toString().trim();
const parsedMaxPages = Number(rawMaxPages);
const fetchMaxPages = Number.isFinite(parsedMaxPages)
  ? Math.min(Math.max(Math.floor(parsedMaxPages), 1), 40)
  : 40;

const fetchPayload = {
  jobId,
  claimToken,
  runId,
  appStoreId,
  country,
  windowDays: fetchWindowDays,
  maxPages: fetchMaxPages,
};

return [{ json: {
  hasClaim: true,
  runId,
  jobId,
  claimKey,
  claimToken,
  leaseExpiresAt,
  attemptCount,
  appStoreId,
  country,
  appName,
  source,
  forceReanalysis,
  status,
  fetchPayload,
} }];
