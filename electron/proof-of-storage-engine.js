import crypto from 'node:crypto';
import { verifyMerkleProof } from './merkle-engine.js';

function signPayload(payload, secret) {
  return crypto.createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');
}

export function createProofEngine({ getNode, getSecret = () => 'local-node-secret' } = {}) {
  function createChallenge(manifest) {
    if (!manifest?.chunks?.length) throw new Error('No chunks to challenge');
    const index = Math.floor(Math.random() * manifest.chunks.length);
    const chunk = manifest.chunks[index];
    return {
      rootHash: manifest.rootHash,
      chunkIndex: index,
      leaf: chunk.hash,
      proof: chunk.proof,
      timestamp: Date.now(),
    };
  }

  function answerChallenge(challenge) {
    const node = getNode?.();
    if (!node) throw new Error('Node not available');
    const chunk = node.getLocalChunk?.(challenge.leaf);
    if (!chunk) throw new Error('Chunk not found locally');

    const response = {
      leaf: challenge.leaf,
      proof: challenge.proof,
      timestamp: Date.now(),
    };

    const signature = signPayload(response, getSecret());

    return { response, signature };
  }

  function verifyChallenge(challenge, answer) {
    const valid = verifyMerkleProof(challenge.rootHash, answer.response.leaf, answer.response.proof);
    return { ok: valid };
  }

  return { createChallenge, answerChallenge, verifyChallenge };
}
