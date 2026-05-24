const fs = require('node:fs');

const file = 'electron/stream-upload-override.js';
if (!fs.existsSync(file)) throw new Error(`${file} not found`);

let src = fs.readFileSync(file, 'utf8');
let changed = false;

if (!src.includes('rollbackUploadedChunks(uploadedChunksForRollback')) {
  console.log('[patch-upload-cancel-full-rollback] skip: rollback helper not present yet');
  process.exit(0);
}

if (src.includes('/* chunknet-full-upload-rollback-start */')) {
  console.log('[patch-upload-cancel-full-rollback] already patched');
  process.exit(0);
}

const readLoopStart = "  for await (const part of fs.createReadStream(filePath, { highWaterMark: CHUNK_SIZE_BYTES })) {";
const finalNestedTry = `  try {
    if (privateFile) await consume(cipher.final());
    if (carry.length || chunks.length === 0) await flush(carry);
  } catch (error) {
    await rollbackUploadedChunks(uploadedChunksForRollback, ownerWallet, error?.code === 'TRANSFER_CANCELLED' ? 'upload-cancelled' : 'upload-failed');
    throw error;
  }`;
const finalPlain = `  if (privateFile) await consume(cipher.final());
  if (carry.length || chunks.length === 0) await flush(carry);`;

if (!src.includes(readLoopStart)) {
  console.log('[patch-upload-cancel-full-rollback] skip: upload read loop marker not found');
  process.exit(0);
}

src = src.replace(
  readLoopStart,
  "  /* chunknet-full-upload-rollback-start */\n  try {\n    for await (const part of fs.createReadStream(filePath, { highWaterMark: CHUNK_SIZE_BYTES })) {"
);
changed = true;

if (src.includes(finalNestedTry)) {
  src = src.replace(
    finalNestedTry,
    `    if (privateFile) await consume(cipher.final());
    if (carry.length || chunks.length === 0) await flush(carry);
  } catch (error) {
    await rollbackUploadedChunks(uploadedChunksForRollback, ownerWallet, error?.code === 'TRANSFER_CANCELLED' ? 'upload-cancelled' : 'upload-failed');
    throw error;
  }
  /* chunknet-full-upload-rollback-end */`
  );
  changed = true;
} else if (src.includes(finalPlain)) {
  src = src.replace(
    finalPlain,
    `    if (privateFile) await consume(cipher.final());
    if (carry.length || chunks.length === 0) await flush(carry);
  } catch (error) {
    await rollbackUploadedChunks(uploadedChunksForRollback, ownerWallet, error?.code === 'TRANSFER_CANCELLED' ? 'upload-cancelled' : 'upload-failed');
    throw error;
  }
  /* chunknet-full-upload-rollback-end */`
  );
  changed = true;
} else {
  console.log('[patch-upload-cancel-full-rollback] warning: final flush marker not found');
}

fs.writeFileSync(file, src, 'utf8');

console.log('[patch-upload-cancel-full-rollback] checks', {
  wrapped: src.includes('/* chunknet-full-upload-rollback-start */') && src.includes('/* chunknet-full-upload-rollback-end */'),
  rollback: src.includes('rollbackUploadedChunks(uploadedChunksForRollback'),
  cancel: src.includes("throwIfTransferCancelled('upload'"),
});

if (changed) console.log('[patch-upload-cancel-full-rollback] patched full rollback wrapper');
