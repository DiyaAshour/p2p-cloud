import 'dotenv/config';
import { ethers } from 'ethers';
import fs from 'node:fs';
import path from 'node:path';
import solc from 'solc';

const RPC_URL = process.env.SEPOLIA_RPC_URL || process.env.RPC_URL;
const PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;
const CONTRACT_PATH = path.resolve('contracts/P2PStorageRewards.sol');

if (!RPC_URL) throw new Error('Missing SEPOLIA_RPC_URL or RPC_URL');
if (!PRIVATE_KEY) throw new Error('Missing DEPLOYER_PRIVATE_KEY');

const source = fs.readFileSync(CONTRACT_PATH, 'utf8');
const input = {
  language: 'Solidity',
  sources: {
    'P2PStorageRewards.sol': { content: source },
  },
  settings: {
    outputSelection: {
      '*': {
        '*': ['abi', 'evm.bytecode'],
      },
    },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = output.errors?.filter((item) => item.severity === 'error') || [];
if (errors.length) {
  throw new Error(errors.map((item) => item.formattedMessage).join('\n'));
}

const contractOutput = output.contracts['P2PStorageRewards.sol'].P2PStorageRewards;
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const factory = new ethers.ContractFactory(contractOutput.abi, contractOutput.evm.bytecode.object, wallet);

console.log(`Deploying from ${wallet.address}...`);
const contract = await factory.deploy();
await contract.waitForDeployment();

const address = await contract.getAddress();
console.log(`P2PStorageRewards deployed: ${address}`);

const artifactDir = path.resolve('deployments');
fs.mkdirSync(artifactDir, { recursive: true });
fs.writeFileSync(
  path.join(artifactDir, 'P2PStorageRewards.json'),
  JSON.stringify({ address, abi: contractOutput.abi }, null, 2)
);

console.log('Add this to .env.local:');
console.log(`VITE_STORAGE_CONTRACT_ADDRESS=${address}`);
