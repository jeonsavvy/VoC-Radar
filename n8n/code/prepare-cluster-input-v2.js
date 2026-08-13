const context = $('Prepare Cluster Context').first().json || {};
const reviewItems = Array.isArray(context.reviewItems) ? context.reviewItems : [];
if (reviewItems.length === 0) return [];
if (!Array.isArray($json.data)) throw new Error('existing cluster context must be an array');
if ($json.data.length > 10000) {
  throw new Error('existing cluster context exceeds 10000 rows');
}

const categories = ['버그 및 성능', '계정 및 결제', '기능 및 사용성', '콘텐츠 및 운영 정책', '긍정 리뷰 및 기타'];
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const utf8Length = (value) => new TextEncoder().encode(value).length;
const koreanSuffixes = ['으로부터', '에서부터', '에게서', '으로', '에서', '에게', '까지', '부터', '처럼', '하고', '하며', '은', '는', '이', '가', '을', '를', '에', '의', '도', '만'];
const tokenize = (...values) => {
  const text = values
    .map((value) => (value || '').toString())
    .join(' ')
    .normalize('NFKC')
    .toLowerCase();
  const rawTokens = text.match(/[가-힣]+|[a-z]+|[0-9]+/g) || [];
  const lexemes = new Set();
  for (const rawToken of rawTokens) {
    if (rawToken.length > 64) continue;
    if (/^[0-9]+$/.test(rawToken) || (/^[a-z]+$/.test(rawToken) && rawToken.length >= 2)) {
      lexemes.add(rawToken);
      continue;
    }
    if (!/^[가-힣]+$/.test(rawToken) || rawToken.length < 2) continue;
    lexemes.add(rawToken);
    let stem = rawToken;
    for (const suffix of koreanSuffixes) {
      if (stem.endsWith(suffix) && stem.length - suffix.length >= 2) {
        stem = stem.slice(0, -suffix.length);
        lexemes.add(stem);
        break;
      }
    }
  }
  return lexemes;
};

const seenIssueIds = new Set();
const seenCanonicalKeys = new Set();
const existingClusters = $json.data.map((row, index) => {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error('invalid existing cluster row at index ' + index);
  }
  const issueId = (row.issueId || '').toString().trim();
  const canonicalKey = (row.canonicalKey || '').toString().trim();
  const title = (row.title || '').toString().trim();
  const category = (row.category || '').toString().trim();
  const summary = (row.summary || '').toString().trim();
  const firstSeenAt = (row.firstSeenAt || '').toString().trim();
  const lastSeenAt = (row.lastSeenAt || '').toString().trim();
  const firstSeenMs = Date.parse(firstSeenAt);
  const lastSeenMs = Date.parse(lastSeenAt);
  const reviewCount = Number(row.reviewCount);
  if (!issueId || issueId.length > 128 || seenIssueIds.has(issueId)) {
    throw new Error('invalid or duplicate existing cluster issueId at index ' + index);
  }
  if (!/^[a-z0-9][a-z0-9-]{1,79}$/.test(canonicalKey) || seenCanonicalKeys.has(canonicalKey)) {
    throw new Error('invalid or duplicate existing cluster canonicalKey at index ' + index);
  }
  if (!title || title.length > 120) throw new Error('invalid existing cluster title at index ' + index);
  if (!categories.includes(category)) throw new Error('invalid existing cluster category at index ' + index);
  if (!summary || summary.length > 400) throw new Error('invalid existing cluster summary at index ' + index);
  if (
    firstSeenAt.length > 64 || lastSeenAt.length > 64 ||
    !Number.isFinite(firstSeenMs) || !Number.isFinite(lastSeenMs) || firstSeenMs > lastSeenMs
  ) {
    throw new Error('invalid existing cluster occurrence window at index ' + index);
  }
  if (!Number.isSafeInteger(reviewCount) || reviewCount < 1) {
    throw new Error('invalid existing cluster reviewCount at index ' + index);
  }
  seenIssueIds.add(issueId);
  seenCanonicalKeys.add(canonicalKey);
  const normalized = {
    issueId, canonicalKey, title, category, summary,
    firstSeenAt, lastSeenAt, reviewCount,
  };
  return {
    normalized,
    tokens: tokenize(canonicalKey, title, summary),
    lastSeenMs,
    jsonBytes: utf8Length(JSON.stringify(normalized)),
  };
});
if (existingClusters.some((entry) => entry.jsonBytes + 2 > 49152)) {
  throw new Error('invalid existing cluster row exceeds the context byte budget');
}

const rawBatchLimit = ($env.VOC_CLUSTER_BATCH_LIMIT || '30').toString().trim();
const parsedBatchLimit = Number(rawBatchLimit);
const batchLimit = Number.isFinite(parsedBatchLimit)
  ? Math.min(Math.max(Math.floor(parsedBatchLimit), 10), 40)
  : 30;
const chunks = [];
for (let offset = 0; offset < reviewItems.length; offset += batchLimit) {
  chunks.push(reviewItems.slice(offset, offset + batchLimit));
}

const { reviewItems: ignoredFullReviewItems, ...sharedContext } = context;
return chunks.map((batchReviews, batchIndex) => {
  const batchCategories = [...new Set(batchReviews.map((review, reviewIndex) => {
    const reviewId = (review?.ID || review?.id || '').toString().trim();
    const category = (review?.category || review?.유형 || '').toString().trim();
    if (!reviewId) throw new Error('cluster batch reviewId is required at index ' + reviewIndex);
    if (!categories.includes(category)) throw new Error('invalid cluster batch category at index ' + reviewIndex);
    return category;
  }))].sort(compareText);
  const batchTokenCounts = new Map();
  for (const review of batchReviews) {
    const reviewTokens = tokenize(
      (review.summary || review.요약 || '').toString().slice(0, 2000),
      (review.content || review.원본 || '').toString().slice(0, 4000),
    );
    for (const lexeme of reviewTokens) {
      batchTokenCounts.set(lexeme, (batchTokenCounts.get(lexeme) || 0) + 1);
    }
  }

  const ranked = existingClusters.map((entry) => {
    let lexicalScore = 0;
    let lexicalHitCount = 0;
    for (const lexeme of entry.tokens) {
      const frequency = batchTokenCounts.get(lexeme) || 0;
      if (frequency > 0) {
        lexicalScore += frequency;
        lexicalHitCount += 1;
      }
    }
    return {
      ...entry,
      categoryMatch: batchCategories.includes(entry.normalized.category) ? 1 : 0,
      lexicalScore,
      lexicalHitCount,
    };
  });
  const relevanceComparator = (left, right) =>
    right.lexicalScore - left.lexicalScore ||
    right.lexicalHitCount - left.lexicalHitCount ||
    right.categoryMatch - left.categoryMatch ||
    right.normalized.reviewCount - left.normalized.reviewCount ||
    right.lastSeenMs - left.lastSeenMs ||
    compareText(left.normalized.canonicalKey, right.normalized.canonicalKey) ||
    compareText(left.normalized.issueId, right.normalized.issueId);
  const anchorComparator = (left, right) =>
    right.normalized.reviewCount - left.normalized.reviewCount ||
    right.lastSeenMs - left.lastSeenMs ||
    compareText(left.normalized.canonicalKey, right.normalized.canonicalKey) ||
    compareText(left.normalized.issueId, right.normalized.issueId);

  let selectedEntries;
  let contextBytes = 2;
  const completeContextBytes = 2 + existingClusters.reduce(
    (total, entry, index) => total + entry.jsonBytes + (index === 0 ? 0 : 1),
    0,
  );
  if (
    existingClusters.length <= 100 &&
    completeContextBytes <= 49152
  ) {
    selectedEntries = [...existingClusters];
    contextBytes = completeContextBytes;
  } else {
    const rankedByRelevance = [...ranked].sort(relevanceComparator);
    const primaryEntries = [];
    const optionalEntries = [];
    const queuedIds = new Set();
    const queueEntry = (target, entry) => {
      if (entry && !queuedIds.has(entry.normalized.issueId)) {
        queuedIds.add(entry.normalized.issueId);
        target.push(entry);
      }
    };

    for (const category of batchCategories) {
      const categoryEntries = ranked
        .filter((entry) => entry.normalized.category === category)
        .sort(anchorComparator);
      queueEntry(primaryEntries, categoryEntries[0]);
    }
    queueEntry(primaryEntries, rankedByRelevance.find((entry) => entry.lexicalScore > 0));
    for (const category of batchCategories) {
      const categoryEntries = ranked
        .filter((entry) => entry.normalized.category === category)
        .sort(anchorComparator);
      queueEntry(optionalEntries, categoryEntries[1]);
      queueEntry(
        optionalEntries,
        categoryEntries.filter((entry) => entry.lexicalScore > 0).sort(relevanceComparator)[0],
      );
    }
    for (const entry of rankedByRelevance.filter((candidate) => candidate.lexicalScore > 0).slice(0, 8)) {
      queueEntry(optionalEntries, entry);
    }

    selectedEntries = [];
    const selectedIds = new Set();
    const addSelected = (entry) => {
      if (!entry || selectedIds.has(entry.normalized.issueId)) return true;
      const nextBytes = contextBytes + entry.jsonBytes + (selectedEntries.length === 0 ? 0 : 1);
      if (selectedEntries.length >= 160 || nextBytes > 49152) {
        return false;
      }
      selectedEntries.push(entry);
      selectedIds.add(entry.normalized.issueId);
      contextBytes = nextBytes;
      return true;
    };
    for (const entry of primaryEntries) addSelected(entry);
    for (const entry of optionalEntries) addSelected(entry);
    for (const entry of rankedByRelevance) addSelected(entry);
    if (existingClusters.length > 0 && selectedEntries.length === 0) {
      throw new Error('existing cluster context selection produced no rows');
    }
  }

  const selectedClusters = selectedEntries.map((entry) => entry.normalized);
  const measuredContextBytes = utf8Length(JSON.stringify(selectedClusters));
  if (
    selectedClusters.length > 160 ||
    measuredContextBytes !== contextBytes ||
    measuredContextBytes > 49152
  ) {
    throw new Error('existing cluster context selection exceeded its hard bounds');
  }

  return { json: {
    ...sharedContext,
    reviewItems: batchReviews,
    existingClusters: selectedClusters,
    existingClusterTotalCount: existingClusters.length,
    existingClusterSelectedCount: selectedClusters.length,
    existingClusterContextBytes: measuredContextBytes,
    clusterBatchIndex: batchIndex,
    clusterBatchCount: chunks.length,
    clusterBatchLimit: batchLimit,
  } };
});
