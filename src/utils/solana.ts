import { Connection, PublicKey, Transaction, Keypair, SystemProgram, Commitment } from "@solana/web3.js";
import { getConfig } from "../config";
import { logInfo, logError } from "../utils/logger";

const config = getConfig();
const connection = new Connection(
  config.SOLANA_NETWORK === "mainnet" ? config.SOLANA_RPC_LIVE_ENDPOINT : config.SOLANA_RPC_DEV_ENDPOINT,
  "confirmed"
);

export const getConnection = () => connection;

export const generateWallet = () => {
  return Keypair.generate();
};

export const getBalance = async (publicKey: PublicKey, commitment?: Commitment): Promise<number> => {
  try {
    const balance = await connection.getBalance(publicKey, commitment);
    const solBalance = balance / 1_000_000_000; // Convert lamports to SOL
    logInfo(`Fetched balance for ${publicKey.toBase58()}: ${solBalance} SOL`, { commitment });
    return solBalance;
  } catch (error) {
    logError(`Error fetching balance for ${publicKey.toBase58()}:`, error);
    return 0;
  }
};

export const transferSol = async (from: Keypair, to: PublicKey, amount: number) => {
  const lamports = Math.round(amount * 1_000_000_000); // Round to ensure integer lamports
  const transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: from.publicKey,
      toPubkey: to,
      lamports: BigInt(lamports), // Explicitly convert to BigInt
    })
  );

  const { blockhash } = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = from.publicKey;

  const signature = await connection.sendTransaction(transaction, [from]);
  logInfo(`Transferred ${amount} SOL from ${from.publicKey.toBase58()} to ${to.toBase58()}. Signature: ${signature}`);
  return signature;
};

export const verifySolPayment = async (
  txSignature: string,
  senderWallet: string,
  receiverWallet: string,
  requiredAmount: number
): Promise<boolean> => {
  try {
    logInfo("Verifying SOL payment:", { txSignature, senderWallet, receiverWallet, requiredAmount });
    const transaction = await connection.getParsedTransaction(txSignature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: undefined,
    });

    if (!transaction || !transaction.meta) {
      logInfo("Transaction not found or not confirmed yet:", { txSignature, transaction });
      return false;
    }

    logInfo("Transaction instructions:", JSON.stringify(transaction.transaction.message.instructions, null, 2));

    const transferInstruction = transaction.transaction.message.instructions.find(
      (ix: any) =>
        ix.programId.toString() === SystemProgram.programId.toString() &&
        ix.parsed?.type === "transfer" &&
        ix.parsed.info.source === senderWallet &&
        ix.parsed.info.destination === receiverWallet &&
        ix.parsed.info.lamports === Math.round(requiredAmount * 1_000_000_000) // Match rounded lamports
    );

    if (!transferInstruction) {
      logInfo("No valid SOL transfer found in transaction. Expected conditions not met.");
      return false;
    }

    logInfo("SOL payment verified successfully:", JSON.stringify(transferInstruction, null, 2));
    return true;
  } catch (error) {
    logError("Error verifying SOL payment:", error);
    return false;
  }
};