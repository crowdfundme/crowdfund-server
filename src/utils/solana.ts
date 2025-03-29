import { Connection, PublicKey, Transaction, Keypair, SystemProgram } from "@solana/web3.js";
import { getConfig } from "../config";

// Function to get the connection (created at runtime, not module initialization)
export const getConnection = () => {
  const config = getConfig(); // Load config at runtime
  return new Connection(
    config.SOLANA_NETWORK === "mainnet" ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com",
    "confirmed"
  );
};

export const generateWallet = () => {
  return Keypair.generate();
};

export const getBalance = async (publicKey: PublicKey): Promise<number> => {
  const connection = getConnection();
  try {
    const balance = await connection.getBalance(publicKey);
    return balance / 1_000_000_000; // Convert lamports to SOL
  } catch (error) {
    console.error("Error fetching balance:", error);
    return 0;
  }
};

export const transferSol = async (from: Keypair, to: PublicKey, amount: number) => {
  const connection = getConnection();
  const transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: from.publicKey,
      toPubkey: to,
      lamports: amount * 1_000_000_000, // Convert SOL to lamports
    })
  );

  const { blockhash } = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = from.publicKey;

  const signature = await connection.sendTransaction(transaction, [from]);
  console.log(`Transferred ${amount} SOL from ${from.publicKey.toBase58()} to ${to.toBase58()}. Signature: ${signature}`);
  return signature;
};

// Verify SOL payment
export const verifySolPayment = async (
  txSignature: string,
  senderWallet: string,
  receiverWallet: string,
  requiredAmount: number
): Promise<boolean> => {
  const connection = getConnection();
  try {
    console.log("Verifying SOL payment:", { txSignature, senderWallet, receiverWallet, requiredAmount });
    const transaction = await connection.getParsedTransaction(txSignature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: undefined,
    });

    if (!transaction || !transaction.meta) {
      console.log("Transaction not found or not confirmed yet:", transaction);
      return false;
    }

    console.log("Transaction instructions:", JSON.stringify(transaction.transaction.message.instructions, null, 2));

    const transferInstruction = transaction.transaction.message.instructions.find(
      (ix: any) =>
        ix.programId.toString() === SystemProgram.programId.toString() &&
        ix.parsed?.type === "transfer" &&
        ix.parsed.info.source === senderWallet &&
        ix.parsed.info.destination === receiverWallet &&
        ix.parsed.info.lamports === requiredAmount * 1_000_000_000
    );

    if (!transferInstruction) {
      console.log("No valid SOL transfer found in transaction. Expected conditions not met.");
      return false;
    }

    console.log("SOL payment verified successfully:", JSON.stringify(transferInstruction, null, 2));
    return true;
  } catch (error) {
    console.error("Error verifying SOL payment:", error);
    return false;
  }
};