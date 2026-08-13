const upsertContext = $('Prepare Upsert Payload').first().json || {};
const payload = upsertContext.payload || {};
const runId = ($json.runId || upsertContext.runId || '').toString().trim();
const jobId = (upsertContext.jobId || payload.jobId || '').toString().trim();
const claimToken = (upsertContext.claimToken || payload.claimToken || '').toString().trim();
const appStoreId = (payload.app?.appStoreId || '').toString().trim();
const country = (payload.app?.country || 'kr').toString().trim().toLowerCase();

if (!runId || !jobId || !claimToken || !appStoreId) {
  throw new Error('publish context is incomplete');
}

return [{ json: {
  runId,
  jobId,
  claimToken,
  payload: {
    runId,
    jobId,
    claimToken,
    appStoreId,
    country,
    publishedAt: new Date().toISOString(),
  },
} }];
