import crypto from 'node:crypto';

export function hashBytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest();
}

export function hashHex(bytes) {
  return `0x${hashBytes(bytes).toString('hex')}`;
}

export function hashPair(left, right) {
  const a = Buffer.isBuffer(left) ? left : Buffer.from(left.replace(/^0x/, ''), 'hex');
  const b = Buffer.isBuffer(right) ? right : Buffer.from(right.replace(/^0x/, ''), 'hex');
  const [x, y] = Buffer.compare(a, b) <= 0 ? [a, b] : [b, a];
  return crypto.createHash('sha256').update(Buffer.concat([x, y])).digest();
}

export function buildMerkleTree(leavesHex) {
  if (!Array.isArray(leavesHex) || leavesHex.length === 0) {
    throw new Error('Merkle tree requires at least one leaf');
  }

  const levels = [leavesHex.map((leaf) => Buffer.from(leaf.replace(/^0x/, ''), 'hex'))];

  while (levels[levels.length - 1].length > 1) {
    const current = levels[levels.length - 1];
    const next = [];

    for (let i = 0; i < current.length; i += 2) {
      const left = current[i];
      const right = current[i + 1] || current[i];
      next.push(hashPair(left, right));
    }

    levels.push(next);
  }

  return {
    root: `0x${levels[levels.length - 1][0].toString('hex')}`,
    levels: levels.map((level) => level.map((item) => `0x${item.toString('hex')}`)),
  };
}

export function getMerkleProof(tree, index) {
  if (!tree?.levels?.length) throw new Error('Invalid Merkle tree');
  if (index < 0 || index >= tree.levels[0].length) throw new Error('Invalid leaf index');

  const proof = [];
  let cursor = index;

  for (let levelIndex = 0; levelIndex < tree.levels.length - 1; levelIndex += 1) {
    const level = tree.levels[levelIndex];
    const siblingIndex = cursor % 2 === 0 ? cursor + 1 : cursor - 1;
    const sibling = level[siblingIndex] || level[cursor];
    proof.push(sibling);
    cursor = Math.floor(cursor / 2);
  }

  return proof;
}

export function verifyMerkleProof(rootHex, leafHex, proof) {
  let computed = Buffer.from(leafHex.replace(/^0x/, ''), 'hex');

  for (const item of proof) {
    computed = hashPair(computed, Buffer.from(item.replace(/^0x/, ''), 'hex'));
  }

  return `0x${computed.toString('hex')}`.toLowerCase() === rootHex.toLowerCase();
}
