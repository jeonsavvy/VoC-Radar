const heartbeat = $input.first().json?.data || {};
if ((heartbeat.status || '').toString() !== 'running' || heartbeat.stage !== 'clustering') {
  throw new Error('pipeline heartbeat response is incomplete');
}
// Checkpoint and restore execute once per splitInBatches iteration. Pinning the
// checkpoint lookup to this restore run prevents an earlier batch from being reused.
const checkpoint = $('Checkpoint Cluster Lease').first(0, $runIndex).json || {};
const resultItems = Array.isArray(checkpoint.resultItems) ? checkpoint.resultItems : [];
if (resultItems.length === 0) throw new Error('pipeline checkpoint result is missing');
return resultItems.map((item) => ({ json: { ...(item.json || {}) } }));
