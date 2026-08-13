const claimKey = ($execution.id || '').toString().trim();
if (!claimKey) throw new Error('execution id is required');
return [{ json: { claimKey, payload: { claimKey } } }];
