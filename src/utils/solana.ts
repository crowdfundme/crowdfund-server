// src/utils/solana.ts
import { Connection, PublicKey, Transaction, Keypair, SystemProgram, Commitment } from "@solana/web3.js";
import Bottleneck from "bottleneck";
import { getConfig } from "../config";
import { logInfo, logError } from "../utils/logger";

const config = getConfig();
const connection = new Connection(
  config.SOLANA_NETWORK === "mainnet" ? config.SOLANA_RPC_LIVE_ENDPOINT : config.SOLANA_RPC_DEV_ENDPOINT,
  "confirmed"
);

// Rate limiter: Adjusted for 40 requests/sec, 2400/minute (example)
const limiter = new Bottleneck({
  maxConcurrent: 10,
  minTime: 25, // ~40 req/sec (1000ms / 40)
  reservoir: 2400,
  reservoirRefreshAmount: 2400,
  reservoirRefreshInterval: 60 * 1000,
});

export const getConnection = () => connection;

export const generateWallet = () => {
  return Keypair.generate();
};

async function withBackoff<T>(fn: () => Promise<T>, maxRetries: number = 5, baseDelay: number = 500): Promise<T> {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      return await fn();
    } catch (error: any) {
      if (error.message.includes("429 Too Many Requests") && attempt < maxRetries - 1) {
        const delay = Math.min(baseDelay * 2 ** attempt, 30000); // Cap at 30s
        const jitter = Math.random() * 100;
        logInfo(`429 detected, retrying after ${delay + jitter}ms`, { attempt: attempt + 1 });
        await new Promise((resolve) => setTimeout(resolve, delay + jitter));
        attempt++;
      } else {
        logError(`RPC call failed after ${attempt + 1} attempts`, error);
        throw error;
      }
    }
  }
  throw new Error("Max retries reached");
}

// Define getBalance with explicit typing
const getBalanceFn = async (publicKey: PublicKey, commitment?: Commitment): Promise<number> => {
  return withBackoff(async () => {
    const balance = await connection.getBalance(publicKey, commitment);
    const solBalance = balance / 1_000_000_000;
    logInfo(`Fetched balance for ${publicKey.toBase58()}: ${solBalance} SOL`, { commitment });
    return solBalance;
  });
};

// Export rate-limited version
export const getBalance: typeof getBalanceFn = limiter.wrap(getBalanceFn);

export const transferSol = limiter.wrap(async (from: Keypair, to: PublicKey, amount: number) => {
  return withBackoff(async () => {
    const lamports = Math.round(amount * 1_000_000_000);
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: from.publicKey,
        toPubkey: to,
        lamports: BigInt(lamports),
      })
    );

    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = from.publicKey;

    const signature = await connection.sendTransaction(transaction, [from], { skipPreflight: true });
    await connection.confirmTransaction(signature, "confirmed");
    logInfo(`Transferred ${amount} SOL from ${from.publicKey.toBase58()} to ${to.toBase58()}`, { signature });
    return signature;
  });
});

export const verifySolPayment = limiter.wrap(
  async (txSignature: string, senderWallet: string, receiverWallet: string, requiredAmount: number): Promise<boolean> => {
    return withBackoff(async () => {
      logInfo("Verifying SOL payment", { txSignature, senderWallet, receiverWallet, requiredAmount });
      const transaction = await connection.getParsedTransaction(txSignature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: undefined,
      });

      if (!transaction || !transaction.meta) {
        logInfo("Transaction not found or not confirmed yet", { txSignature });
        return false;
      }

      logInfo("Transaction instructions", JSON.stringify(transaction.transaction.message.instructions, null, 2));
      const lamportsExpected = Math.round(requiredAmount * 1_000_000_000);
      const transferInstruction = transaction.transaction.message.instructions.find(
        (ix: any) =>
          ix.programId.toString() === SystemProgram.programId.toString() &&
          ix.parsed?.type === "transfer" &&
          ix.parsed.info.source === senderWallet &&
          ix.parsed.info.destination === receiverWallet &&
          Math.abs(ix.parsed.info.lamports - lamportsExpected) <= 100
      );

      if (!transferInstruction) {
        logInfo("No valid SOL transfer found", { expectedLamports: lamportsExpected });
        return false;
      }

      logInfo("SOL payment verified successfully", JSON.stringify(transferInstruction, null, 2));
      return true;
    });
  }
);