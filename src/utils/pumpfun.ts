import { Keypair, PublicKey } from "@solana/web3.js";
import { transferSol, connection } from "./solana";
import axios from "axios";

export const createAndLaunchToken = async (
  fundWallet: Keypair,
  tokenName: string,
  tokenSymbol: string,
  targetSol: number, // Target amount (e.g., 9.204131229 SOL)
  targetWallet: PublicKey
): Promise<string> => {
  const launchFee = 0.1;

  // Assume 0.1 SOL is already in fundWallet (paid by user)
  console.log(`Using ${launchFee} SOL from campaign wallet as gas fee`);
  console.log(`Creating token with ${targetSol} SOL for ${tokenName} (${tokenSymbol})`);

  // Mock pump.fun token creation (replace with real API)
  const response = await axios.post("https://pump.fun/api/create-token", {
    name: tokenName,
    symbol: tokenSymbol,
    amount: targetSol, // Use target amount for token creation
    creator: fundWallet.publicKey.toBase58(),
    gasFee: launchFee, // Hypothetical field; adjust per real API
  }).catch(() => ({
    data: { tokenAddress: "mock_token_address" },
  }));

  const tokenAddress = response.data.tokenAddress;
  console.log(`Token ${tokenAddress} launched, transferring 25% to ${targetWallet.toBase58()}`);

  // TODO: Transfer 25% of token supply to targetWallet (requires SPL Token logic)
  return tokenAddress;
};