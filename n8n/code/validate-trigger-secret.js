const expected = ($env.N8N_PIPELINE_TRIGGER_SECRET || '').toString().trim();
if (!expected) {
  throw new Error('trigger secret is not configured');
}

const headers = $json.headers || {};
const provided = (headers['x-voc-trigger-secret'] || headers['X-Voc-Trigger-Secret'] || '')
  .toString()
  .trim();
if (!provided || provided !== expected) {
  throw new Error('trigger secret rejected');
}

return [{ json: { triggerSource: 'webhook' } }];
