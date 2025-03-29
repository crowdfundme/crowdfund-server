import { Keypair, PublicKey } from "@solana/web3.js";
import { transferSol, getConnection } from "./solana"; // Update to import getConnection
import { createMint, mintTo, getOrCreateAssociatedTokenAccount, transfer } from "@solana/spl-token";

// Mock function to simulate token creation and launch on Pump.fun
export const createAndLaunchToken = async (
  fundWallet: Keypair,
  tokenName: string,
  tokenSymbol: string,
  targetSol: number,
  targetWallet: PublicKey
): Promise<string> => {
  const connection = getConnection(); // Use getConnection() to get the connection
  const launchFee = 0.1; // This should be the initialFeePaid, but for mock purposes, we'll use 0.1

  console.log(`Using ${launchFee} SOL from campaign wallet as gas fee`);
  console.log(`Creating token with ${targetSol} SOL for ${tokenName} (${tokenSymbol})`);

  // Step 1: Simulate transferring the target SOL amount to the target wallet
  // In a real Pump.fun integration, this SOL would be used to fund the bonding curve
  await transferSol(fundWallet, targetWallet, targetSol);

  // Step 2: Create a new SPL token mint (simulating token creation)
  const mint = await createMint(
    connection,
    fundWallet, // Payer of the transaction fees
    fundWallet.publicKey, // Mint authority
    null, // Freeze authority (null means no freeze authority)
    9 // Decimals (standard for most tokens)
  );

  // Step 3: Create associated token accounts for the fund wallet and target wallet
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

  // Step 4: Mint the initial token supply to the fund wallet
  const totalSupply = 1_000_000_000 * 10 ** 9; // 1 billion tokens (with 9 decimals)
  await mintTo(
    connection,
    fundWallet, // Payer of the transaction fees
    mint,
    fundWalletTokenAccount.address,
    fundWallet.publicKey, // Mint authority
    totalSupply
  );

  // Step 5: Transfer 25% of the token supply to the target wallet
  const amountToTransfer = totalSupply * 0.25; // 25% of the total supply
  await transfer(
    connection,
    fundWallet, // Payer of the transaction fees
    fundWalletTokenAccount.address, // Source token account
    targetWalletTokenAccount.address, // Destination token account
    fundWallet.publicKey, // Owner of the source account
    amountToTransfer
  );

  console.log(`Token ${mint.toBase58()} launched, transferred 25% (${amountToTransfer / 10 ** 9} tokens) to ${targetWallet.toBase58()}`);

  // Return the token mint address
  return mint.toBase58();
};