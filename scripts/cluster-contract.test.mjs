import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';
import { validateClusterContract } from './cluster-contract.mjs';

const workerSource = await readFile(new URL('../apps/worker/src/cluster-contract.ts', import.meta.url), 'utf8');
const workerJavaScript = await transform(workerSource, { loader: 'ts', format: 'esm', target: 'es2022' });
const workerContract = await import(`data:text/javascript;base64,${Buffer.from(workerJavaScript.code).toString('base64')}`);
const workerPlatformSource = await readFile(new URL('../apps/worker/src/platform.ts', import.meta.url), 'utf8');
const workerPlatformJavaScript = await transform(workerPlatformSource, {
  loader: 'ts', format: 'esm', target: 'es2022',
});
const workerPlatform = await import(
  `data:text/javascript;base64,${Buffer.from(workerPlatformJavaScript.code).toString('base64')}`
);
const validators = [validateClusterContract, workerContract.validateClusterContract];
const workflow = JSON.parse(
  await readFile(new URL('../n8n/workflow.supabase-only.json', import.meta.url), 'utf8'),
);
const workflowFixtures = JSON.parse(
  await readFile(new URL('./fixtures/workflow-stage-gates.json', import.meta.url), 'utf8'),
);

const workflowNode = (name) => workflow.nodes.find((node) => node.name === name);
const executeWorkflowCodeNode = (name, inputItems, nodeItems = {}, env = {}, runIndex = 0) => {
  const code = workflowNode(name)?.parameters?.jsCode;
  assert.equal(typeof code, 'string', `workflow Code node is missing: ${name}`);

  const itemsForRun = (nodeName, requestedRunIndex) => {
    const configured = nodeItems[nodeName] || [];
    if (!Array.isArray(configured[0])) return configured;
    const selectedRunIndex = requestedRunIndex === undefined || requestedRunIndex === -1
      ? configured.length - 1
      : requestedRunIndex;
    return configured[selectedRunIndex] || [];
  };
  const selectNode = (nodeName) => ({
    all: (_branchIndex, requestedRunIndex) =>
      structuredClone(itemsForRun(nodeName, requestedRunIndex)),
    first: (_branchIndex, requestedRunIndex) =>
      structuredClone(itemsForRun(nodeName, requestedRunIndex)[0] || { json: {} }),
  });
  const input = {
    all: () => structuredClone(inputItems),
    first: () => structuredClone(inputItems[0] || { json: {} }),
  };

  return new Function('$input', '$', '$env', '$json', '$runIndex', code)(
    input,
    selectNode,
    env,
    structuredClone(inputItems[0]?.json || {}),
    runIndex,
  );
};

const mainTargets = (name, outputIndex = 0) =>
  (workflow.connections?.[name]?.main?.[outputIndex] || []).map((connection) => connection.node);

const base = {
  extractions: [
    { reviewId: 'r1', category: '버그 및 성능', summary: '실행 실패' },
    { reviewId: 'r2', category: '버그 및 성능', summary: '로그인 크래시' },
  ],
  clusters: [{
    canonicalKey: 'startup-crash',
    title: '앱 실행 실패',
    category: '버그 및 성능',
    severity: 'high',
    summary: '앱이 시작 구간에서 종료된다.',
    reviewIds: ['r1', 'r2'],
  }],
};

const existingClusterRow = (index, overrides = {}) => ({
  issueId: `issue-${index}`,
  canonicalKey: `cluster-key-${index}`,
  title: `기존 이슈 ${index}`,
  category: ['버그 및 성능', '계정 및 결제', '기능 및 사용성', '콘텐츠 및 운영 정책', '긍정 리뷰 및 기타'][index % 5],
  summary: `기존 이슈의 관찰 근거 ${index}`,
  firstSeenAt: '2026-01-01T00:00:00.000Z',
  lastSeenAt: new Date(Date.UTC(2026, 6, 1 + (index % 28))).toISOString(),
  reviewCount: 20_000 - index,
  ...overrides,
});

test('accepts an exact one-cluster assignment', () => {
  for (const validate of validators) {
    const result = validate(['r1', 'r2'], base);
    assert.equal(result.validation.assignedReviewCount, 2);
  }
});

test('rejects hallucinated review ids', () => {
  const invalid = structuredClone(base);
  invalid.clusters[0].reviewIds = ['r1', 'not-a-review'];
  for (const validate of validators) {
    assert.throws(() => validate(['r1', 'r2'], invalid), /unknown cluster reviewId/);
  }
});

test('rejects duplicate assignments', () => {
  const invalid = structuredClone(base);
  invalid.clusters.push({ ...invalid.clusters[0], canonicalKey: 'other', reviewIds: ['r2'] });
  for (const validate of validators) {
    assert.throws(() => validate(['r1', 'r2'], invalid), /assigned more than once/);
  }
});

test('blocks all Stage 1 persistence when any extraction batch has a parse error', () => {
  const output = executeWorkflowCodeNode(
    'Gate Extraction Batches',
    workflowFixtures.mixedExtractionItems,
  );
  const parseErrors = output.filter((item) =>
    String(item.json?.ID || '').startsWith('PARSE_ERROR_'),
  );
  const persistenceItems = output.filter(
    (item) => !String(item.json?.ID || '').startsWith('PARSE_ERROR_'),
  );

  assert.equal(persistenceItems.length, 0);
  assert.equal(parseErrors.length, 1);
});

test('turns missing or extra Stage 1 LLM batches into one atomic parse error', () => {
  for (const [label, llmItems, received] of [
    ['missing', workflowFixtures.missingExtractionLlmItems, 1],
    ['extra', workflowFixtures.extraExtractionLlmItems, 3],
  ]) {
    const parsed = executeWorkflowCodeNode('Parse JSON Response', llmItems, {
      'Ensure New Reviews': workflowFixtures.extractionBatchContexts,
    });
    assert.equal(parsed.length, 1, label);
    assert.match(String(parsed[0].json.ID), /^PARSE_ERROR_/, label);
    assert.match(
      String(parsed[0].json.요약),
      new RegExp(`extraction batch count mismatch: expected 2, received ${received}`),
      label,
    );

    const gated = executeWorkflowCodeNode('Gate Extraction Batches', parsed);
    assert.equal(
      gated.filter((item) => !String(item.json?.ID || '').startsWith('PARSE_ERROR_')).length,
      0,
      label,
    );
    assert.equal(gated.length, 1, label);
  }
});

test('persists canonical Critical alerts before reusing every review in the publish path', () => {
  const prepared = executeWorkflowCodeNode(
    'Prepare Alert Events Payload',
    workflowFixtures.alertInputItems,
    { 'Prepare Run Context': [{ json: workflowFixtures.runContext }] },
  );

  assert.equal(prepared.length, 1);
  assert.equal(prepared[0].json.hasCriticalAlerts, true);
  const canonicalCriticalIds = workflowFixtures.alertInputItems
    .filter(({ json }) => {
      const category = workerPlatform.normalizeVocCategory(json.category, json.summary, '');
      return workerPlatform.derivePriorityValue(Number(json.rating), category, json.priority) === 'Critical';
    })
    .map(({ json }) => json.ID);
  assert.deepEqual(
    prepared[0].json.payload.alerts.map((alert) => alert.reviewId),
    canonicalCriticalIds,
  );
  assert.ok(prepared[0].json.payload.alerts.every((alert) => alert.priority === 'Critical'));
  assert.equal(Object.hasOwn(prepared[0].json, 'reviewItems'), false);

  const clusterContext = executeWorkflowCodeNode('Prepare Cluster Context', prepared, {
    'Filter Duplicates': workflowFixtures.alertInputItems,
    'Prepare Run Context': [{ json: workflowFixtures.runContext }],
    'Filter New Reviews via BFF': [{ json: { data: { existingExtractions: [] } } }],
  });
  assert.deepEqual(
    clusterContext[0].json.reviewItems.map((item) => item.ID),
    ['review-critical', 'review-promoted-bug', 'review-promoted-account', 'review-normal'],
  );

  assert.deepEqual(mainTargets('Filter Duplicates'), ['Prepare Alert Events Payload']);
  assert.deepEqual(mainTargets('Prepare Alert Events Payload'), ['Has Critical Alerts?']);
  assert.deepEqual(mainTargets('Has Critical Alerts?', 0), ['Send Alert Events to BFF']);
  assert.deepEqual(mainTargets('Has Critical Alerts?', 1), ['Prepare Cluster Context']);
  assert.deepEqual(mainTargets('Send Alert Events to BFF'), ['Prepare Cluster Context']);
  assert.equal(workflowNode('Restore Reviews After Alerts'), undefined);
});

test('skips the alert HTTP path and reuses every review when no Critical alert exists', () => {
  const prepared = executeWorkflowCodeNode(
    'Prepare Alert Events Payload',
    workflowFixtures.nonCriticalAlertInputItems,
    { 'Prepare Run Context': [{ json: workflowFixtures.runContext }] },
  );

  assert.equal(prepared.length, 1);
  assert.equal(prepared[0].json.hasCriticalAlerts, false);
  assert.deepEqual(prepared[0].json.payload.alerts, []);

  const selectedOutput = prepared[0].json.hasCriticalAlerts ? 0 : 1;
  assert.deepEqual(mainTargets('Has Critical Alerts?', selectedOutput), [
    'Prepare Cluster Context',
  ]);
  assert.ok(!mainTargets('Has Critical Alerts?', selectedOutput).includes('Send Alert Events to BFF'));

  const clusterContext = executeWorkflowCodeNode('Prepare Cluster Context', prepared, {
    'Filter Duplicates': workflowFixtures.nonCriticalAlertInputItems,
    'Prepare Run Context': [{ json: workflowFixtures.runContext }],
    'Filter New Reviews via BFF': [{ json: { data: { existingExtractions: [] } } }],
  });
  assert.deepEqual(
    clusterContext[0].json.reviewItems.map((item) => item.ID),
    ['review-high', 'review-normal'],
  );
  assert.equal(Object.hasOwn(prepared[0].json, 'reviewItems'), false);
});

test('keeps a 10k-review alert barrier singleton without copying the full review set', () => {
  const reviews = Array.from({ length: 10_000 }, (_, index) => ({
    json: {
      ...workflowFixtures.runContext,
      ID: `review-${index}`,
      priority: 'Normal',
      category: '긍정 리뷰 및 기타',
      summary: '정상 리뷰',
      rating: '5',
    },
  }));
  const prepared = executeWorkflowCodeNode('Prepare Alert Events Payload', reviews, {
    'Prepare Run Context': [{ json: workflowFixtures.runContext }],
  });

  assert.equal(prepared.length, 1);
  assert.equal(prepared[0].json.hasCriticalAlerts, false);
  assert.equal(prepared[0].json.payload.alerts.length, 0);
  assert.equal(Object.hasOwn(prepared[0].json, 'reviewItems'), false);

  const clusterContext = executeWorkflowCodeNode('Prepare Cluster Context', prepared, {
    'Filter Duplicates': reviews,
    'Prepare Run Context': [{ json: workflowFixtures.runContext }],
    'Filter New Reviews via BFF': [{ json: { data: { existingExtractions: [] } } }],
  });
  assert.equal(clusterContext.length, 1);
  assert.equal(clusterContext[0].json.reviewItems.length, 10_000);
});

test('preserves every valid existing cluster when the context has at most 100 rows', () => {
  const existingClusters = Array.from({ length: 100 }, (_, index) => existingClusterRow(index));
  const reviewItems = Array.from({ length: 35 }, (_, index) => ({
    ID: `review-${index}`,
    category: '기능 및 사용성',
    summary: '검색 필터가 필요하다.',
    content: '검색 필터 요청',
  }));
  const batches = executeWorkflowCodeNode(
    'Prepare Cluster Input',
    [{ json: { data: existingClusters } }],
    { 'Prepare Cluster Context': [{ json: { ...workflowFixtures.runContext, reviewItems } }] },
    { VOC_CLUSTER_BATCH_LIMIT: '30' },
  );

  assert.equal(batches.length, 2);
  for (const batch of batches) {
    assert.equal(batch.json.existingClusterTotalCount, 100);
    assert.equal(batch.json.existingClusterSelectedCount, 100);
    assert.deepEqual(
      batch.json.existingClusters.map((cluster) => cluster.issueId),
      existingClusters.map((cluster) => cluster.issueId),
    );
    assert.equal(
      batch.json.existingClusterContextBytes,
      Buffer.byteLength(JSON.stringify(batch.json.existingClusters), 'utf8'),
    );
    assert.ok(batch.json.existingClusterContextBytes <= 49_152);
  }
});

test('selects by relevance instead of failing when a 100-row context exceeds 48 KiB', () => {
  const existingClusters = Array.from({ length: 100 }, (_, index) => existingClusterRow(index, {
    title: `기존 이슈 ${index} ` + '제목'.repeat(40),
    summary: `기존 이슈 ${index} ` + '상세근거'.repeat(95),
  }));
  existingClusters[99] = existingClusterRow(99, {
    canonicalKey: 'dense-long-tail-context',
    title: '밀집 장기꼬리 문맥',
    category: '기능 및 사용성',
    summary: '밀집장기꼬리 어휘가 일치한다. ' + '상세근거'.repeat(85),
    reviewCount: 1,
  });
  const reviewItems = [{
    ID: 'review-dense',
    category: '기능 및 사용성',
    summary: '밀집장기꼬리 문제가 발생한다.',
    content: '밀집장기꼬리 재현',
  }];
  const batches = executeWorkflowCodeNode(
    'Prepare Cluster Input',
    [{ json: { data: existingClusters } }],
    { 'Prepare Cluster Context': [{ json: { ...workflowFixtures.runContext, reviewItems } }] },
  );

  assert.equal(batches.length, 1);
  assert.equal(batches[0].json.existingClusterTotalCount, 100);
  assert.ok(batches[0].json.existingClusterSelectedCount < 100);
  assert.ok(batches[0].json.existingClusterSelectedCount > 0);
  assert.ok(batches[0].json.existingClusterContextBytes <= 49_152);
  assert.ok(
    batches[0].json.existingClusters.some((cluster) => cluster.issueId === 'issue-99'),
    'the oversized small context must still retain its lexical match',
  );
});

test('selects deterministic bounded per-batch context and retains a lexical long-tail match', () => {
  const existingClusters = Array.from({ length: 10_000 }, (_, index) => existingClusterRow(index));
  existingClusters[9_500] = existingClusterRow(9_500, {
    canonicalKey: 'rare-sync-zxq-991',
    title: '희귀동기화 ZXQ 991 실패',
    category: '기능 및 사용성',
    summary: '희귀동기화 작업에서 ZXQ 991 오류가 발생한다.',
    reviewCount: 1,
  });
  existingClusters[9_999] = existingClusterRow(9_999, {
    canonicalKey: 'identity-never-selected-9999',
    title: '선택되면 안 되는 장기 꼬리',
    summary: '어떤 배치와도 어휘가 겹치지 않는 표식이다.',
    reviewCount: 1,
  });
  const reviewItems = Array.from({ length: 60 }, (_, index) => ({
    ID: `review-${index}`,
    category: index < 30 ? '기능 및 사용성' : '계정 및 결제',
    summary: index === 0
      ? '희귀동기화가 ZXQ 991 오류로 실패한다.'
      : index < 30 ? '검색 필터 사용성 요청' : '결제 영수증 확인 요청',
    content: index === 0 ? '희귀동기화 ZXQ 991 재현' : '일반 사용자 의견',
  }));
  const nodeItems = {
    'Prepare Cluster Context': [{ json: { ...workflowFixtures.runContext, reviewItems } }],
  };
  const input = [{ json: { data: existingClusters } }];
  const first = executeWorkflowCodeNode(
    'Prepare Cluster Input', input, nodeItems, { VOC_CLUSTER_BATCH_LIMIT: '30' },
  );
  const second = executeWorkflowCodeNode(
    'Prepare Cluster Input', input, nodeItems, { VOC_CLUSTER_BATCH_LIMIT: '30' },
  );

  assert.deepEqual(first, second, 'selection must not depend on input traversal side effects');
  assert.equal(first.length, 2);
  assert.ok(
    first[0].json.existingClusters.some((cluster) => cluster.issueId === 'issue-9500'),
    'a Korean/Latin/numeric lexical match beyond the former top-100 cutoff must be selected',
  );
  assert.ok(
    first[0].json.existingClusters.some((cluster) => cluster.issueId === 'issue-2'),
    'the highest-frequency anchor for the first batch category must be selected',
  );
  assert.ok(
    first[1].json.existingClusters.some((cluster) => cluster.issueId === 'issue-1'),
    'the highest-frequency anchor for the second batch category must be selected',
  );
  for (const batch of first) {
    assert.equal(batch.json.existingClusterTotalCount, 10_000);
    assert.equal(batch.json.existingClusterSelectedCount, batch.json.existingClusters.length);
    assert.ok(batch.json.existingClusters.length <= 160);
    assert.ok(batch.json.existingClusters.length < existingClusters.length);
    assert.equal(
      batch.json.existingClusterContextBytes,
      Buffer.byteLength(JSON.stringify(batch.json.existingClusters), 'utf8'),
    );
    assert.ok(batch.json.existingClusterContextBytes <= 49_152);
    assert.equal(Object.hasOwn(batch.json, 'allExistingClusters'), false);
  }
  assert.equal(
    JSON.stringify(first).includes('identity-never-selected-9999'),
    false,
    'the complete 10k context must not be copied into every batch item',
  );
});

test('fails closed for malformed or oversized existing-cluster context', () => {
  const reviewItems = [{
    ID: 'review-1', category: '기능 및 사용성', summary: '검색', content: '검색',
  }];
  const nodeItems = {
    'Prepare Cluster Context': [{ json: { ...workflowFixtures.runContext, reviewItems } }],
  };
  const malformed = existingClusterRow(0);
  delete malformed.summary;
  assert.throws(
    () => executeWorkflowCodeNode('Prepare Cluster Input', [{ json: { data: [malformed] } }], nodeItems),
    /invalid existing cluster summary/,
  );
  assert.throws(
    () => executeWorkflowCodeNode(
      'Prepare Cluster Input',
      [{ json: { data: Array.from({ length: 10_001 }, (_, index) => existingClusterRow(index)) } }],
      nodeItems,
    ),
    /existing cluster context exceeds 10000 rows/,
  );
  assert.throws(
    () => executeWorkflowCodeNode('Prepare Cluster Input', [{ json: { data: null } }], nodeItems),
    /existing cluster context must be an array/,
  );
});

test('renews and fences every extraction, clustering, and consolidation model result', () => {
  for (const contract of [
    {
      loop: 'Loop Extraction Batches',
      llm: 'Basic LLM Chain',
      checkpoint: 'Checkpoint Extraction Lease',
      renew: 'Renew Extraction Lease',
      restore: 'Restore Extraction Result',
      done: 'Parse JSON Response',
      stage: 'extracting',
    },
    {
      loop: 'Loop Cluster Batches',
      llm: 'Cluster Review Issues',
      checkpoint: 'Checkpoint Cluster Lease',
      renew: 'Renew Cluster Lease',
      restore: 'Restore Cluster Result',
      done: 'Validate Cluster Output',
      stage: 'clustering',
    },
  ]) {
    const firstModelItems = [{ json: { text: '{"batch":1}' } }];
    const secondModelItems = [{ json: { text: '{"batch":2}' } }];
    const firstCheckpoint = executeWorkflowCodeNode(contract.checkpoint, firstModelItems, {
      'Prepare Run Context': [{ json: workflowFixtures.runContext }],
    });
    const secondCheckpoint = executeWorkflowCodeNode(contract.checkpoint, secondModelItems, {
      'Prepare Run Context': [{ json: workflowFixtures.runContext }],
    });
    assert.equal(firstCheckpoint.length, 1, contract.stage);
    assert.equal(firstCheckpoint[0].json.heartbeatPayload.stage, contract.stage);
    assert.deepEqual(firstCheckpoint[0].json.resultItems, firstModelItems);
    assert.deepEqual(secondCheckpoint[0].json.resultItems, secondModelItems);

    const invalidCardinalityCheckpoint = executeWorkflowCodeNode(
      contract.checkpoint,
      [...firstModelItems, ...secondModelItems],
      { 'Prepare Run Context': [{ json: workflowFixtures.runContext }] },
    );
    assert.equal(invalidCardinalityCheckpoint[0].json.resultItems.length, 1, contract.stage);
    assert.match(
      invalidCardinalityCheckpoint[0].json.resultItems[0].json.modelCardinalityError,
      /expected 1, received 2/,
      contract.stage,
    );

    const checkpointRuns = [firstCheckpoint, secondCheckpoint];
    const firstRestored = executeWorkflowCodeNode(
      contract.restore,
      [{ json: { data: { status: 'running', stage: contract.stage } } }],
      { [contract.checkpoint]: checkpointRuns },
      {},
      0,
    );
    const secondRestored = executeWorkflowCodeNode(
      contract.restore,
      [{ json: { data: { status: 'running', stage: contract.stage } } }],
      { [contract.checkpoint]: checkpointRuns },
      {},
      1,
    );
    assert.deepEqual(firstRestored, firstModelItems, `${contract.stage} run 0`);
    assert.deepEqual(secondRestored, secondModelItems, `${contract.stage} run 1`);

    assert.throws(
      () => executeWorkflowCodeNode(
        contract.restore,
        [{ json: { data: { status: 'running', stage: contract.stage === 'extracting' ? 'clustering' : 'extracting' } } }],
        { [contract.checkpoint]: checkpointRuns },
        {},
        1,
      ),
      /pipeline heartbeat response is incomplete/,
      contract.stage,
    );

    assert.equal(workflowNode(contract.loop).parameters.batchSize, 1);
    assert.equal(workflowNode(contract.llm).alwaysOutputData, true);
    assert.deepEqual(mainTargets(contract.loop, 0), [contract.done]);
    assert.deepEqual(mainTargets(contract.loop, 1), [contract.llm]);
    assert.deepEqual(mainTargets(contract.llm), [contract.checkpoint]);
    assert.deepEqual(mainTargets(contract.checkpoint), [contract.renew]);
    assert.deepEqual(mainTargets(contract.renew), [contract.restore]);
    assert.deepEqual(mainTargets(contract.restore), [contract.loop]);
    assert.equal(workflowNode(contract.renew).continueOnFail, undefined);
  }

  const consolidationItems = [{ json: { text: '{"groups":[]}' } }];
  const consolidationCheckpoint = executeWorkflowCodeNode(
    'Checkpoint Consolidation Lease',
    consolidationItems,
    { 'Prepare Run Context': [{ json: workflowFixtures.runContext }] },
  );
  const consolidationRestored = executeWorkflowCodeNode(
    'Restore Consolidation Result',
    [{ json: { data: { status: 'running', stage: 'clustering' } } }],
    { 'Checkpoint Consolidation Lease': consolidationCheckpoint },
  );
  assert.deepEqual(consolidationRestored, consolidationItems);
  assert.deepEqual(mainTargets('Consolidate Cluster Candidates'), ['Checkpoint Consolidation Lease']);
  assert.deepEqual(mainTargets('Checkpoint Consolidation Lease'), ['Renew Consolidation Lease']);
  assert.deepEqual(mainTargets('Renew Consolidation Lease'), ['Restore Consolidation Result']);
  assert.deepEqual(mainTargets('Restore Consolidation Result'), ['Loop Consolidation Batches']);
  assert.deepEqual(mainTargets('Loop Consolidation Batches', 0), ['Validate Consolidated Clusters']);
  assert.deepEqual(mainTargets('Loop Consolidation Batches', 1), ['Consolidate Cluster Candidates']);
});

test('rejects missing or extra cluster model batches before any successful subset can persist', () => {
  const contexts = [
    { json: { ...workflowFixtures.runContext, reviewItems: [{ ID: 'review-1', appStoreId: '1', country: 'kr' }] } },
    { json: { ...workflowFixtures.runContext, reviewItems: [{ ID: 'review-2', appStoreId: '1', country: 'kr' }] } },
  ];
  for (const [label, llmItems, received] of [
    ['missing', [{ json: { text: '{}' } }], 1],
    ['extra', [{ json: { text: '{}' } }, { json: { text: '{}' } }, { json: { text: '{}' } }], 3],
  ]) {
    const output = executeWorkflowCodeNode('Validate Cluster Output', llmItems, {
      'Prepare Cluster Input': contexts,
    });
    assert.equal(output.length, 1, label);
    assert.match(output[0].json.ID, /^PARSE_ERROR_CLUSTER_CARDINALITY_/, label);
    assert.match(output[0].json.요약, new RegExp(`expected 2, received ${received}`), label);
  }
});

test('partitions and validates the 10k consolidation boundary without truncating candidates', () => {
  const inputReviewIds = Array.from({ length: 10_000 }, (_, index) => `review-${index}`);
  const sourceClusters = inputReviewIds.map((reviewId, index) => ({
    existingClusterId: null,
    canonicalKey: `candidate-key-${index}`,
    title: `이슈 ${index}`,
    category: '기능 및 사용성',
    severity: 'low',
    summary: `근거 ${index}`,
    actionHint: '',
    reviewIds: [reviewId],
    representativeReviewIds: [reviewId],
  }));
  const sourceContext = {
    ...workflowFixtures.runContext,
    reviewItems: inputReviewIds.map((ID) => ({ ID, appStoreId: '1', country: 'kr' })),
    inputReviewIds,
    result: {
      extractions: inputReviewIds.map((reviewId) => ({
        reviewId, category: '기능 및 사용성', summary: '근거',
      })),
      clusters: sourceClusters,
    },
    validation: { passed: true, assignedReviewCount: inputReviewIds.length },
  };

  const batches = executeWorkflowCodeNode('Prepare Consolidation Batches', [{ json: sourceContext }]);
  assert.ok(batches.length > 1);
  assert.ok(batches.every((item) => item.json.candidateCount <= 48));
  assert.ok(batches.every((item) => item.json.promptBytes <= 65_536));
  assert.deepEqual(
    new Set(batches.flatMap((item) => item.json.candidates.map((candidate) => candidate.candidateId))),
    new Set(sourceClusters.map((_, index) => `candidate-${index}`)),
  );
  assert.equal(
    batches.reduce((total, item) => total + item.json.candidateCount, 0),
    sourceClusters.length,
  );

  const llmItems = batches.map(({ json }) => ({
    json: {
      text: JSON.stringify({
        groups: json.candidates.map((candidate) => ({
          candidateIds: [candidate.candidateId],
          existingClusterId: candidate.existingClusterId,
          canonicalKey: candidate.canonicalKey,
          title: candidate.title,
          category: candidate.category,
          severity: candidate.severity,
          summary: candidate.summary,
          actionHint: '검토한다.',
        })),
      }),
    },
  }));
  const consolidated = executeWorkflowCodeNode(
    'Validate Consolidated Clusters',
    llmItems,
    {
      'Prepare Consolidation Batches': batches,
      'Merge Cluster Batches': [{ json: sourceContext }],
    },
  );
  assert.equal(consolidated.length, 1);
  assert.equal(consolidated[0].json.validation.candidateClusterCount, 10_000);
  assert.equal(consolidated[0].json.validation.assignedReviewCount, 10_000);
  assert.equal(consolidated[0].json.result.clusters.length, 10_000);
});

test('uses UTF-8 prompt bytes and rejects overlong candidate fields instead of truncating them', () => {
  const clusters = Array.from({ length: 100 }, (_, index) => ({
    existingClusterId: null,
    canonicalKey: `unicode-key-${index}`,
    title: '가'.repeat(120),
    category: '기능 및 사용성',
    severity: 'low',
    summary: '나'.repeat(400),
    reviewIds: [`review-${index}`],
    representativeReviewIds: [`review-${index}`],
  }));
  const context = {
    ...workflowFixtures.runContext,
    reviewItems: [{ appStoreId: '1', country: 'kr' }],
    result: { extractions: [], clusters },
  };
  const batches = executeWorkflowCodeNode('Prepare Consolidation Batches', [{ json: context }]);
  assert.ok(batches.length > 2, 'UTF-8 byte budget should split dense Korean fields');
  assert.ok(batches.every((item) => item.json.promptBytes <= 65_536));
  assert.equal(batches.reduce((sum, item) => sum + item.json.candidateCount, 0), 100);

  const invalid = structuredClone(context);
  invalid.result.clusters[0].title = '가'.repeat(121);
  const rejected = executeWorkflowCodeNode('Prepare Consolidation Batches', [{ json: invalid }]);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].json.ID, /^PARSE_ERROR_CLUSTER_CONSOLIDATION_INPUT_/);
  assert.match(rejected[0].json.요약, /candidate title length is invalid/);
});

test('merges bounded candidates while preserving every source membership exactly once', () => {
  const sourceContext = {
    ...workflowFixtures.runContext,
    reviewItems: [
      { ID: 'review-1', appStoreId: '1', country: 'kr' },
      { ID: 'review-2', appStoreId: '1', country: 'kr' },
      { ID: 'review-3', appStoreId: '1', country: 'kr' },
    ],
    inputReviewIds: ['review-1', 'review-2', 'review-3'],
    result: {
      extractions: [
        { reviewId: 'review-1', category: '버그 및 성능', summary: '충돌' },
        { reviewId: 'review-2', category: '버그 및 성능', summary: '종료' },
        { reviewId: 'review-3', category: '기능 및 사용성', summary: '요청' },
      ],
      clusters: [
        {
          existingClusterId: null, canonicalKey: 'startup-crash-a', title: '실행 충돌',
          category: '버그 및 성능', severity: 'high', summary: '실행 중 충돌한다.',
          reviewIds: ['review-1'], representativeReviewIds: ['review-1'],
        },
        {
          existingClusterId: null, canonicalKey: 'startup-crash-b', title: '실행 종료',
          category: '버그 및 성능', severity: 'high', summary: '실행 직후 종료된다.',
          reviewIds: ['review-2'], representativeReviewIds: ['review-2'],
        },
        {
          existingClusterId: null, canonicalKey: 'export-request', title: '내보내기 요청',
          category: '기능 및 사용성', severity: 'low', summary: '내보내기가 필요하다.',
          reviewIds: ['review-3'], representativeReviewIds: ['review-3'],
        },
      ],
    },
    validation: { passed: true },
  };
  const batches = executeWorkflowCodeNode('Prepare Consolidation Batches', [{ json: sourceContext }]);
  assert.equal(batches.length, 1);

  const response = [{ json: { text: JSON.stringify({ groups: [
    {
      candidateIds: ['candidate-0', 'candidate-1'], existingClusterId: null,
      canonicalKey: 'startup-crash-a', title: '앱 실행 충돌', category: '버그 및 성능',
      severity: 'high', summary: '앱이 실행 구간에서 충돌하거나 종료된다.', actionHint: '시작 로그를 확인한다.',
    },
    {
      candidateIds: ['candidate-2'], existingClusterId: null,
      canonicalKey: 'export-request', title: '내보내기 요청', category: '기능 및 사용성',
      severity: 'low', summary: '내보내기 기능 요청이다.', actionHint: '요청 우선순위를 검토한다.',
    },
  ] }) } }];
  const output = executeWorkflowCodeNode('Validate Consolidated Clusters', response, {
    'Prepare Consolidation Batches': batches,
    'Merge Cluster Batches': [{ json: sourceContext }],
  });
  assert.equal(output[0].json.result.clusters.length, 2);
  assert.deepEqual(output[0].json.result.clusters[0].reviewIds.sort(), ['review-1', 'review-2']);
  assert.deepEqual(
    output[0].json.result.clusters.flatMap((cluster) => cluster.reviewIds).sort(),
    ['review-1', 'review-2', 'review-3'],
  );

  const missing = structuredClone(response);
  missing[0].json.text = JSON.stringify({ groups: [JSON.parse(response[0].json.text).groups[0]] });
  const rejected = executeWorkflowCodeNode('Validate Consolidated Clusters', missing, {
    'Prepare Consolidation Batches': batches,
    'Merge Cluster Batches': [{ json: sourceContext }],
  });
  assert.match(rejected[0].json.ID, /^PARSE_ERROR_CLUSTER_CONSOLIDATION_/);
  assert.match(rejected[0].json.요약, /unassigned batch candidateIds/);
});

test('builds the 10k review persistence payload without duplicating raw review fields', () => {
  const reviewItems = Array.from({ length: 10_000 }, (_, index) => ({
    ...workflowFixtures.runContext,
    ID: `review-${index}`,
    rating: 3,
    author: `author-${index}`,
    content: `raw-content-${index}`,
    date: '2026-07-28T00:00:00.000Z',
    priority: 'Normal',
    category: '기능 및 사용성',
    summary: `summary-${index}`,
    appStoreId: '123456789',
    country: 'kr',
    appName: '테스트 앱',
    isExisting: false,
  }));
  const inputReviewIds = reviewItems.map((review) => review.ID);
  const prepared = executeWorkflowCodeNode(
    'Prepare Upsert Payload',
    [{ json: {
      ...workflowFixtures.runContext,
      reviewItems,
      inputReviewIds,
      result: { extractions: [], clusters: [] },
      forceReanalysis: false,
    } }],
  );

  assert.equal(prepared.length, 1);
  assert.equal(prepared[0].json.payload.reviews.length, 10_000);
  assert.ok(prepared[0].json.payload.reviews.every((review) => !Object.hasOwn(review, 'rawSource')));
  assert.equal(Object.hasOwn(prepared[0].json, 'reviewItems'), false);
  const serializedPayload = JSON.stringify(prepared[0].json.payload);
  assert.equal(serializedPayload.includes('"rawSource"'), false);
  for (const index of [0, 5_000, 9_999]) {
    const exactContent = JSON.stringify(`raw-content-${index}`);
    assert.equal(
      serializedPayload.split(exactContent).length - 1,
      1,
      `raw content ${index} must appear exactly once in the persistence request`,
    );
  }
});

test('budgets persistence HTTP requests for their complete Worker endpoint paths', () => {
  assert.equal(workflowNode('Upsert Reviews to BFF')?.parameters?.options?.timeout, 100_000);
  assert.equal(workflowNode('Upsert Clusters to BFF')?.parameters?.options?.timeout, 150_000);
});

test('rejects an incomplete review collection before database preflight', () => {
  const context = [{ json: workflowFixtures.runContext }];
  assert.throws(
    () => executeWorkflowCodeNode(
      'Prepare Preflight Reviews Payload',
      [{ json: { data: { complete: false, truncated: true, reviews: [] } } }],
      { 'Prepare Run Context': context },
    ),
    /did not prove the requested window complete/,
  );
  const prepared = executeWorkflowCodeNode(
    'Prepare Preflight Reviews Payload',
    [{ json: { data: { complete: true, truncated: false, reviews: [] } } }],
    { 'Prepare Run Context': context },
  );
  assert.deepEqual(prepared[0].json.payload.reviews, []);
});

test('turns the 10k input boundary into bounded one-at-a-time model iterations', () => {
  const freshReviews = Array.from({ length: 10_000 }, (_, index) => ({
    reviewId: `review-${index}`,
    author: 'tester',
    reviewedAt: '2026-07-28T00:00:00.000Z',
    rating: 3,
    content: `review ${index}`,
  }));
  const extractionBatches = executeWorkflowCodeNode(
    'Ensure New Reviews',
    [{ json: { data: { reviews: freshReviews, existingExtractions: [] } } }],
    { 'Prepare Run Context': [{ json: { ...workflowFixtures.runContext, forceReanalysis: false } }] },
    { VOC_LLM_BATCH_LIMIT: '50' },
  );
  assert.equal(extractionBatches.length, 200);
  assert.ok(extractionBatches.every((item) => item.json.reviews.length <= 50));
  assert.equal(workflowNode('Loop Extraction Batches').parameters.batchSize, 1);

  const reviewItems = freshReviews.map((review) => ({
    ID: review.reviewId,
    category: '긍정 리뷰 및 기타',
    summary: review.content,
    rating: review.rating,
    content: review.content,
  }));
  const clusterBatches = executeWorkflowCodeNode(
    'Prepare Cluster Input',
    [{ json: { data: [] } }],
    { 'Prepare Cluster Context': [{ json: { ...workflowFixtures.runContext, reviewItems } }] },
    { VOC_CLUSTER_BATCH_LIMIT: '30' },
  );
  assert.equal(clusterBatches.length, 334);
  assert.ok(clusterBatches.every((item) => item.json.reviewItems.length <= 30));
  assert.equal(workflowNode('Loop Cluster Batches').parameters.batchSize, 1);
});
