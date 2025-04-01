// src/utils/solana.ts
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  SendOptions,
  Signer,
  VersionedTransaction,
} from "@solana/web3.js";
import Bottleneck from "bottleneck";
import { getConfig } from "../config";

// Load configuration
const config = getConfig();

// Rate limiter for Solana RPC calls
const limiter = new Bottleneck({
  maxConcurrent: 2,
  minTime: 100,
  reservoir: 40,
  reservoirRefreshAmount: 40,
  reservoirRefreshInterval: 60 * 1000,
});

let connection: Connection;

export const getConnection = (): Connection => {
  if (!connection) {
    const RPC_ENDPOINT = config.SOLANA_NETWORK === "mainnet" ? config.SOLANA_RPC_LIVE_ENDPOINT : config.SOLANA_RPC_DEV_ENDPOINT;
    connection = new Connection(RPC_ENDPOINT, "confirmed");
    console.log(`Solana connection established to ${RPC_ENDPOINT}`);

    // Store original methods
    const originalMethods = {
      getBalance: connection.getBalance.bind(connection),
      getLatestBlockhash: connection.getLatestBlockhash.bind(connection),
      getParsedTransaction: connection.getParsedTransaction.bind(connection),
      confirmTransaction: connection.confirmTransaction.bind(connection),
      sendTransaction: connection.sendTransaction.bind(connection),
      getTokenAccountBalance: connection.getTokenAccountBalance.bind(connection),
      getParsedAccountInfo: connection.getParsedAccountInfo.bind(connection),
    };

    // Wrap methods with throttling
    connection.getBalance = async (publicKey, commitment) =>
      limiter.schedule(() => originalMethods.getBalance(publicKey, commitment));
    connection.getLatestBlockhash = async (commitmentOrConfig) =>
      limiter.schedule(() => originalMethods.getLatestBlockhash(commitmentOrConfig));
    connection.getParsedTransaction = async (txSignature, options) =>
      limiter.schedule(() => originalMethods.getParsedTransaction(txSignature, options));
    connection.confirmTransaction = async (txSignature, commitment) =>
      limiter.schedule(() => originalMethods.confirmTransaction(txSignature as string, commitment));

    // Overload signatures for sendTransaction
    async function sendTransaction(
      transaction: Transaction,
      signers: Signer[],
      options?: SendOptions
    ): Promise<string>;
    async function sendTransaction(
      transaction: VersionedTransaction,
      options?: SendOptions
    ): Promise<string>;
    async function sendTransaction(
      transaction: Transaction | VersionedTransaction,
      signersOrOptions?: Signer[] | SendOptions,
      options?: SendOptions
    ): Promise<string> {
      if ('signatures' in transaction) {
        // Transaction case
        const signers = signersOrOptions as Signer[];
        return limiter.schedule(() => originalMethods.sendTransaction(transaction as Transaction, signers, options));
      } else {
        // VersionedTransaction case
        const opts = signersOrOptions as SendOptions | undefined;
        return limiter.schedule(() => originalMethods.sendTransaction(transaction as VersionedTransaction, opts));
      }
    }
    connection.sendTransaction = sendTransaction;

    connection.getTokenAccountBalance = async (publicKey, commitment) =>
      limiter.schedule(() => originalMethods.getTokenAccountBalance(publicKey, commitment));
    connection.getParsedAccountInfo = async (publicKey, commitment) =>
      limiter.schedule(() => originalMethods.getParsedAccountInfo(publicKey, commitment));
  }
  return connection;
};

// Throttled RPC call wrapper with retries
const withRetry = async <T>(fn: () => Promise<T>, maxRetries = 5, baseDelay = 500): Promise<T> => {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      if (error.message?.includes("429 Too Many Requests") && attempt < maxRetries) {
        const delay = baseDelay * 2 ** attempt;
        console.log(`Server responded with 429 Too Many Requests. Retrying after ${delay}ms delay...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }
  throw new Error("Max retries reached");
};

export const transferSol = async (fromWallet: Keypair, toPublicKey: PublicKey, amountSol: number): Promise<string> => {
  const connection = getConnection();
  const lamports = Math.floor(amountSol * LAMPORTS_PER_SOL);

  const transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: fromWallet.publicKey,
      toPubkey: toPublicKey,
      lamports,
    })
  );

  const { blockhash } = await withRetry(() => connection.getLatestBlockhash("confirmed"));
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = fromWallet.publicKey;

  const signature = await withRetry(() => connection.sendTransaction(transaction, [fromWallet], { skipPreflight: true }));
  await confirmTransaction(signature);
  return signature;
};

export const verifySolPayment = async (
  txSignature: string,
  senderWallet: string,
  receiverWallet: string,
  requiredAmount: number
): Promise<boolean> => {
  const connection = getConnection();
  const senderPublicKey = new PublicKey(senderWallet);
  const receiverPublicKey = new PublicKey(receiverWallet);
  const requiredLamports = Math.floor(requiredAmount * LAMPORTS_PER_SOL);

  const txInfo = await withRetry(() => connection.getParsedTransaction(txSignature, { commitment: "confirmed" }));
  if (!txInfo || txInfo.slot === 0) {
    throw new Error(`Transaction ${txSignature} not found or not confirmed`);
  }

  const instructions = txInfo.transaction.message.instructions;
  console.log("Transaction instructions", instructions);

  const transferInstruction = instructions.find((instr) =>
    "parsed" in instr &&
    instr.parsed.type === "transfer" &&
    instr.program === "system" &&
    instr.parsed.info.source === senderPublicKey.toBase58() &&
    instr.parsed.info.destination === receiverPublicKey.toBase58()
  );

  if (!transferInstruction || !("parsed" in transferInstruction)) {
    throw new Error("No valid SOL transfer found in transaction");
  }

  const { lamports } = transferInstruction.parsed.info;
  if (lamports < requiredLamports) {
    throw new Error(`Transferred amount ${lamports / LAMPORTS_PER_SOL} SOL is less than required ${requiredAmount} SOL`);
  }

  console.log("SOL payment verified successfully", transferInstruction);
  return true;
};

export const confirmTransaction = async (txSignature: string): Promise<void> => {
  const connection = getConnection();
  await withRetry(() => connection.confirmTransaction(txSignature, "confirmed"));
  console.log(`Transaction ${txSignature} confirmed`);
};

export const getBalance = async (publicKey: PublicKey): Promise<number> => {
  const connection = getConnection();
  const balance = await withRetry(() => connection.getBalance(publicKey, "confirmed"));
  console.log(`Fetched balance for ${publicKey.toBase58()}: ${balance / LAMPORTS_PER_SOL} SOL`, { commitment: "confirmed" });
  return balance / LAMPORTS_PER_SOL;
};

export const generateWallet = (): Keypair => {
  return Keypair.generate();
};