const context = $('Prepare Run Context').first().json || {};
const jobId = (context.jobId || '').toString().trim();
const claimToken = (context.claimToken || '').toString().trim();
const runId = (context.runId || '').toString().trim();
if (!jobId || !claimToken || !runId) throw new Error('heartbeat claim context is incomplete');

let resultItems = $input.all().map((item) => ({ json: { ...(item.json || {}) } }));
if (resultItems.length !== 1) {
  resultItems = [{ json: {
    text: '',
    modelCardinalityError: 'extraction model result count mismatch: expected 1, received ' + resultItems.length,
  } }];
}

return [{ json: {
  runId,
  phase: 'extraction',
  resultItems,
  heartbeatPayload: { jobId, claimToken, runId, stage: 'extracting' },
} }];
