import { Connection, Keypair, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL, clusterApiUrl } from "@solana/web3.js";

export const connection = new Connection(
  process.env.SOLANA_NETWORK === "mainnet"
    ? clusterApiUrl("mainnet-beta")
    : clusterApiUrl("devnet"),
  "confirmed"
);

export const generateWallet = () => Keypair.generate();

export const getBalance = async (publicKey: PublicKey) => {
  return (await connection.getBalance(publicKey)) / LAMPORTS_PER_SOL;
};

export const transferSol = async (
  fromKeypair: Keypair,
  toPublicKey: PublicKey,
  amount: number
) => {
  const transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: fromKeypair.publicKey,
      toPubkey: toPublicKey,
      lamports: amount * LAMPORTS_PER_SOL,
    })
  );
  const { blockhash } = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = fromKeypair.publicKey;

  const signature = await connection.sendTransaction(transaction, [fromKeypair]);
  await connection.confirmTransaction(signature);
  return signature;
};