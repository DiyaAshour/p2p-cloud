const fs = require('node:fs');
const path = require('node:path');

const file = path.join(process.cwd(), 'electron', 'seed-auth-cooldown-ipc.js');
if (!fs.existsSync(file)) {
  console.log('[seed-auth-lazy-argon2] seed-auth-cooldown-ipc.js not found; skipping');
  process.exit(0);
}

let source = fs.readFileSync(file, 'utf8');
const before = source;

source = source.replace("import argon2 from 'argon2';\n", '');
source = source.replace("import argon2 from 'argon2';\r\n", '');

if (!source.includes('async function getArgon2()')) {
  source = source.replace(
    "const MAX_WAIT_MS = Number(process.env.P2P_SEED_MAX_WAIT_MS || 24 * 60 * 60 * 1000);",
    "const MAX_WAIT_MS = Number(process.env.P2P_SEED_MAX_WAIT_MS || 24 * 60 * 60 * 1000);\nlet argon2ModulePromise = null;\nasync function getArgon2() {\n  if (!argon2ModulePromise) {\n    argon2ModulePromise = import('argon2').then((mod) => mod.default || mod);\n  }\n  return argon2ModulePromise;\n}"
  );
}

source = source.replace(
  /async function keyFromPassword\(p, saltBase64\) \{ return argon2\.hash\(password\(p\), \{ type: argon2\.argon2id, salt: Buffer\.from\(String\(saltBase64 \|\| ''\), 'base64'\), raw: true, hashLength: 32, memoryCost: ARGON2_MEMORY_KIB, timeCost: ARGON2_TIME_COST, parallelism: ARGON2_PARALLELISM \}\); \}/,
  "async function keyFromPassword(p, saltBase64) { const argon2 = await getArgon2(); return argon2.hash(password(p), { type: argon2.argon2id, salt: Buffer.from(String(saltBase64 || ''), 'base64'), raw: true, hashLength: 32, memoryCost: ARGON2_MEMORY_KIB, timeCost: ARGON2_TIME_COST, parallelism: ARGON2_PARALLELISM }); }"
);

if (source !== before) {
  fs.writeFileSync(file, source, 'utf8');
  console.log('[seed-auth-lazy-argon2] patched seed auth to lazy-load argon2');
} else {
  console.log('[seed-auth-lazy-argon2] already patched or anchor not found');
}
