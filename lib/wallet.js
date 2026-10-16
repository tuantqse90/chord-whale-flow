// Your wallet, used only in live mode (LIVE=1). Loaded lazily, so paper mode runs without installing viem.
// The key stays on your machine: Chord returns an unsigned transaction and this file signs it.
import { createPublicClient, createWalletClient, defineChain, http, erc20Abi, maxUint256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CONFIG } from './config.js';

const NATIVE = '0x0000000000000000000000000000000000000000';
const clients = new Map();

function viemChain(chain) {
  if (!CONFIG.rpcUrl) throw new Error('RPC_URL is not set: live mode sends through your own RPC endpoint.');
  return defineChain({
    id: chain.id, name: chain.name,
    nativeCurrency: { name: chain.native.symbol, symbol: chain.native.symbol, decimals: chain.native.decimals },
    rpcUrls: { default: { http: [CONFIG.rpcUrl] } },
  });
}

export function publicClient(chain) {
  const k = `pub:${chain.id}`;
  if (!clients.has(k)) clients.set(k, createPublicClient({ chain: viemChain(chain), transport: http(CONFIG.rpcUrl) }));
  return clients.get(k);
}

export function walletClient(chain) {
  if (!CONFIG.privateKey) throw new Error('PRIVATE_KEY is not set: cannot sign. Keep LIVE=0 for paper mode.');
  const k = `wal:${chain.id}`;
  if (!clients.has(k)) {
    const pk = CONFIG.privateKey.startsWith('0x') ? CONFIG.privateKey : `0x${CONFIG.privateKey}`;
    clients.set(k, createWalletClient({ account: privateKeyToAccount(pk), chain: viemChain(chain), transport: http(CONFIG.rpcUrl) }));
  }
  return clients.get(k);
}

export const address = (chain) => walletClient(chain).account.address;

export async function balanceOf(chain, token, owner = address(chain)) {
  if (token.toLowerCase() === NATIVE) return publicClient(chain).getBalance({ address: owner });
  return publicClient(chain).readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] });
}

export async function ensureAllowance(chain, token, spender, amount) {
  if (token.toLowerCase() === NATIVE) return null;
  const pub = publicClient(chain);
  const wallet = walletClient(chain);
  const current = await pub.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [wallet.account.address, spender] });
  if (current >= BigInt(amount)) return null;
  // Some tokens (USDT on Ethereum) refuse a new allowance while the old one is not zero.
  if (current > 0n) await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: token, abi: erc20Abi, functionName: 'approve', args: [spender, 0n] }) });
  const hash = await wallet.writeContract({ address: token, abi: erc20Abi, functionName: 'approve', args: [spender, maxUint256] });
  await pub.waitForTransactionReceipt({ hash });
  return hash;
}

export async function sendTx(chain, { to, data, value = '0', gasLimit, gas }) {
  const wallet = walletClient(chain);
  const g = gasLimit || gas;
  const hash = await wallet.sendTransaction({ to, data, value: BigInt(value || 0), gas: g ? BigInt(g) : undefined });
  const receipt = await publicClient(chain).waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`tx reverted: ${hash}`);
  return { hash, receipt };
}
