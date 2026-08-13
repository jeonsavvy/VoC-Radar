const expected = ($env.N8N_PIPELINE_TRIGGER_SECRET || '').toString().trim();
if (!expected) {
  throw new Error('trigger secret is not configured');
}

const headers = $json.headers || {};
const timestampText = (headers['x-voc-timestamp'] || headers['X-Voc-Timestamp'] || '')
  .toString()
  .trim();
const provided = (headers['x-voc-signature'] || headers['X-Voc-Signature'] || '')
  .toString()
  .trim()
  .toLowerCase();
const timestamp = Number(timestampText);
if (
  !Number.isSafeInteger(timestamp)
  || Math.abs(Date.now() - timestamp) > 300_000
  || !/^[0-9a-f]{64}$/.test(provided)
) {
  throw new Error('trigger secret rejected');
}

const { createHmac, timingSafeEqual } = require('crypto');
const rawBody = JSON.stringify($json.body || {});
const expectedSignature = createHmac('sha256', expected)
  .update(`${timestampText}.${rawBody}`)
  .digest();
const providedSignature = Buffer.from(provided, 'hex');
if (
  providedSignature.length !== expectedSignature.length
  || !timingSafeEqual(providedSignature, expectedSignature)
) {
  throw new Error('trigger secret rejected');
}

return [{ json: { triggerSource: 'webhook' } }];
