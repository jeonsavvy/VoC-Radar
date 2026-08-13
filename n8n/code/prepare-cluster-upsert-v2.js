const upsert = $('Prepare Upsert Payload').first().json || {};
const app = upsert.payload?.app || {};
return [{ json: { runId: upsert.runId, jobId: upsert.jobId, claimToken: upsert.claimToken, payload: {
  runId: upsert.runId, jobId: upsert.jobId, claimToken: upsert.claimToken,
  appStoreId: app.appStoreId, country: app.country,
  modelVersion: upsert.modelVersion, comparisonEligible: upsert.comparisonEligible,
  inputReviewIds: upsert.inputReviewIds, result: upsert.clusterResult
} } }];
