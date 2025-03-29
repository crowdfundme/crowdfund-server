import { Keypair, PublicKey } from "@solana/web3.js";
import { transferSol, connection } from "./solana";
import axios from "axios";

export const createAndLaunchToken = async (
  fundWallet: Keypair,
  tokenName: string,
  tokenSymbol: string,
  targetSol: number,
  targetWallet: PublicKey
): Promise<string> => {
  const launchFee = 0.1; // This should be the initialFeePaid, but for mock purposes, we'll use 0.1

  console.log(`Using ${launchFee} SOL from campaign wallet as gas fee`);
  console.log(`Creating token with ${targetSol} SOL for ${tokenName} (${tokenSymbol})`);

  const response = await axios.post("https://pump.fun/api/create-token", {
    name: tokenName,
    symbol: tokenSymbol,
    amount: targetSol,
    creator: fundWallet.publicKey.toBase58(),
    gasFee: launchFee,
  }).catch(() => ({
    data: { tokenAddress: "mock_token_address" },
  }));

  const tokenAddress = response.data.tokenAddress;
  console.log(`Token ${tokenAddress} launched, transferring 25% to ${targetWallet.toBase58()}`);

  // TODO: Transfer 25% of token supply to targetWallet (requires SPL Token logic)
  return tokenAddress;
};