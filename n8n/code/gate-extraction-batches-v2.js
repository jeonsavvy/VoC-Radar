const items = $input.all();
const parseErrors = items.filter((item) =>
  (item.json?.ID || '').toString().startsWith('PARSE_ERROR_')
);

if (parseErrors.length > 0) {
  return [{ json: { ...(parseErrors[0].json || {}) } }];
}

return items;
