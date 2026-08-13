const item = $input.first().json || {};
const context = $('Prepare Run Context').first().json || {};
const appStoreId = (item.appStoreId || context.appStoreId || '').toString().trim() || null;
const country = (item.country || context.country || '').toString().trim().toLowerCase() || null;
const runId = (item.runId || context.runId || '').toString().trim();
const jobId = (item.jobId || context.jobId || '').toString().trim();
const claimToken = (item.claimToken || context.claimToken || '').toString().trim();
if (!runId || !jobId || !claimToken) throw new Error('parse error context is incomplete');

const payload = {
  parseErrorId: (item.ID || 'PARSE_ERROR_' + Date.now()).toString(),
  jobId,
  claimToken,
  runId,
  appStoreId,
  country,
  message: (item.요약 || item.message || 'No valid data parsed').toString(),
  rawResponse: (item.원본 || '').toString(),
};

return [{ json: { runId, jobId, claimToken, payload } }];
