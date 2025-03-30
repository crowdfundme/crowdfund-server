import { Keypair, PublicKey } from "@solana/web3.js";
import { transferSol, getConnection } from "./solana";
import { createMint, mintTo, getOrCreateAssociatedTokenAccount, transfer } from "@solana/spl-token";

export const createAndLaunchToken = async (
  fundWallet: Keypair,
  tokenName: string,
  tokenSymbol: string,
  targetSol: number,
  targetWallet: PublicKey,
  initialFeePaid: number,
  targetPercentage: number
): Promise<string> => {
  const connection = getConnection();
  const launchFee = initialFeePaid;

  console.log(`Using ${launchFee} SOL from campaign wallet as gas fee`);
  console.log(`Creating token with ${targetSol} SOL for ${tokenName} (${tokenSymbol}) at ${targetPercentage}% target`);

  try {
    const balance = await connection.getBalance(fundWallet.publicKey) / 1_000_000_000;
    const requiredSol = targetSol + 0.01; // Buffer for fees
    if (balance < requiredSol) {
      throw new Error(`Insufficient funds in fundWallet: ${balance} SOL, required: ${requiredSol} SOL`);
    }

    await transferSol(fundWallet, targetWallet, targetSol);

    const mint = await createMint(
      connection,
      fundWallet,
      fundWallet.publicKey,
      null,
      9
    );

    const fundWalletTokenAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      fundWallet,
      mint,
      fundWallet.publicKey
    );

    const targetWalletTokenAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      fundWallet,
      mint,
      targetWallet
    );

    const totalSupply = 1_000_000_000 * 10 ** 9; // 1 billion tokens
    await mintTo(
      connection,
      fundWallet,
      mint,
      fundWalletTokenAccount.address,
      fundWallet.publicKey,
      totalSupply
    );

    const amountToTransfer = totalSupply * (targetPercentage / 100);
    await transfer(
      connection,
      fundWallet,
      fundWalletTokenAccount.address,
      targetWalletTokenAccount.address,
      fundWallet.publicKey,
      amountToTransfer
    );

    console.log(
      `Token ${mint.toBase58()} launched, transferred ${targetPercentage}% (${
        amountToTransfer / 10 ** 9
      } tokens) to ${targetWallet.toBase58()}`
    );
    return mint.toBase58();
  } catch (error) {
    console.error("Failed to create and launch token:", error);
    throw error;
  }
};