import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { validateClusterContract } from './cluster-contract.mjs';
import { createClusterContractFixtures } from '../contracts/cluster-contract.fixtures.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = resolve(root, 'scripts/fixtures/clustering.ko.synthetic.json');
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
const result = validateClusterContract(fixture.inputReviewIds, fixture.candidate);

if (!result.validation.passed || result.validation.assignedReviewCount !== fixture.inputReviewIds.length) {
  throw new Error('synthetic clustering fixture did not satisfy the contract');
}

for (const contractFixture of createClusterContractFixtures()) {
  if (contractFixture.outcome === 'valid') {
    validateClusterContract(contractFixture.inputReviewIds, contractFixture.candidate);
  } else {
    let rejected = false;
    try {
      validateClusterContract(contractFixture.inputReviewIds, contractFixture.candidate);
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error(`adversarial fixture was accepted: ${contractFixture.name}`);
  }
}

console.log(`Cluster contract valid: ${result.validation.assignedReviewCount} reviews, ${result.validation.clusterCount} clusters`);
