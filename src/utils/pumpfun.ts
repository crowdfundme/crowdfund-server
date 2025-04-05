import {
  Keypair,
  PublicKey,
  Connection,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
  RpcResponseAndContext,
  TokenAmount,
  TransactionMessage,
  VersionedTransaction,
  ParsedAccountData,
} from "@solana/web3.js";
import { transferSol, getConnection, getBalance, confirmTransaction } from "./solana";
import { createMint, mintTo, getOrCreateAssociatedTokenAccount, transfer, getAssociatedTokenAddress } from "@solana/spl-token";
import bs58 from "bs58";
import { getConfig } from "../config";
import Fund from "../models/Fund";

const RETRY_DELAY = 1000; // Initial 1 second
const MAX_RETRIES = 8;

// Utility to wait with retries and exponential backoff
async function waitWithRetries<T>(
  action: () => Promise<T>,
  condition: (result: T) => boolean,
  errorMessage: string,
  retries = MAX_RETRIES,
  delay = RETRY_DELAY
): Promise<T> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const result = await action();
      if (condition(result)) {
        console.log(`${errorMessage} succeeded on attempt ${attempt + 1}`);
        return result;
      }
      throw new Error(`${errorMessage} condition not met`);
    } catch (error) {
      if (attempt === retries - 1) {
        console.error(`${errorMessage} failed after ${retries} attempts:`, error);
        throw error;
      }
      const waitTime = delay * Math.pow(2, attempt);
      console.log(`${errorMessage} failed, retrying (${attempt + 1}/${retries}) in ${waitTime / 1000}s...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }
  throw new Error("Unreachable code");
}

// Fetch with retry utility, including rate limit handling
async function fetchWithRetry(url: string, options: RequestInit, retries = 3): Promise<Response> {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, options);
      if (response.status === 429) {
        const retryAfter = response.headers.get("Retry-After") || "5";
        const delay = parseInt(retryAfter, 10) * 1000;
        console.log(`Rate limited, retrying after ${delay / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      return response;
    } catch (error) {
      if (i === retries - 1) throw error;
      console.log(`Fetch failed, retrying (${i + 1}/${retries})`, error);
      await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
    }
  }
  throw new Error("Max retries reached");
}

// Dynamic gas fee calculation
const calculateGasFeeReserve = async (connection: Connection): Promise<number> => {
  try {
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    const dummyMessage = new TransactionMessage({
      payerKey: new PublicKey("11111111111111111111111111111111"),
      recentBlockhash: blockhash,
      instructions: [],
    }).compileToV0Message();

    const feeResponse = await connection.getFeeForMessage(dummyMessage, "confirmed");
    if (!feeResponse.value) {
      throw new Error("Failed to calculate transaction fee");
    }
    return (feeResponse.value * 10) / LAMPORTS_PER_SOL;
  } catch (error) {
    console.error("Failed to calculate gas fee reserve:", error);
    return 0.05; // Fallback
  }
};

// Centralized SOL calculation utility  
  /**
 * Calculates SOL allocations for transferring to the Pump wallet and token creation.
 * @param donatedSol - Total SOL donated to the fund (e.g., currentDonatedSol).
 * @param initialFeePaid - Initial fee paid for creating the fund (e.g., 0.1 SOL).
 * @param targetSol - Target SOL amount for the fund (e.g., 0.3 SOL from targetPercentage).
 * @returns Object containing SOL amounts for creation, total transfer to Pump wallet, and fee retained in fund wallet.
 */
const calculateSolForPump = (
  donatedSol: number,
  initialFeePaid: number,
  targetSol: number
): { solForCreation: number; totalSolForPump: number; feeRaiseWallet: number } => {
  // Validate inputs to prevent unexpected behavior
  if (donatedSol < 0 || initialFeePaid < 0 || targetSol <= 0) {
    throw new Error(
      `Invalid input: donatedSol (${donatedSol}), initialFeePaid (${initialFeePaid}), or targetSol (${targetSol}) must be non-negative and targetSol must be positive`
    );
  }

  // Portion of initial fee retained in fund wallet (30% of initialFeePaid)
  const feeRaiseWallet = initialFeePaid * 0.3;

  // Portion of initial fee available for gas fees (70% of initialFeePaid)
  const gasFeePortion = initialFeePaid - feeRaiseWallet;

  // SOL allocated for token creation, capped at targetSol
  const solForCreation = Math.min(donatedSol, targetSol);

  // Total SOL to transfer to Pump wallet: creation amount + gas fee portion
  const totalSolForPump = solForCreation + gasFeePortion;

  // Ensure totalSolForPump is non-negative (though unlikely with valid inputs)
  if (totalSolForPump < 0) {
    throw new Error(`Calculated totalSolForPump is negative: ${totalSolForPump}`);
  }

  return {
    solForCreation,
    totalSolForPump,
    feeRaiseWallet,
  };
};

// Main token creation function with Lightning API
export const createAndLaunchTokenWithLightning = async (
  fundWallet: Keypair,
  tokenName: string,
  tokenSymbol: string,
  targetSol: number,
  targetWallet: PublicKey,
  initialFeePaid: number,
  targetPercentage: number,
  imageUrl: string,
  totalSolToTransfer: number,
  fundId: string
): Promise<{ tokenAddress: string; apiKey: string; walletPublicKey: string; privateKey: string; solscanUrl: string; metadataUri: string }> => {
  console.log("Running pumpfun.ts version: 2025-04-05 (Lightning Transaction with Delays and Retries)");
  const connection = getConnection();
  const GAS_FEE_RESERVE = await calculateGasFeeReserve(connection);
  const FUND_WALLET_MINIMUM = 0.01;
  const MIN_EXCESS_THRESHOLD = 0.005;
  const config = getConfig();

  try {
    const fund = await Fund.findById(fundId);
    if (!fund) throw new Error(`Fund with ID ${fundId} not found`);

    console.log(`Fund ${fundId} PumpPortal fields:`, {
      publicKey: fund.pumpPortalWalletPublicKey,
      privateKey: fund.pumpPortalPrivateKey,
      apiKey: fund.pumpPortalApiKey,
      transferCompleted: fund.pumpPortalTransferCompleted,
      currentDonatedSol: fund.currentDonatedSol,
    });

    let walletPublicKey: string;
    let privateKey: string;
    let apiKey: string;
    let pumpWalletKeypair: Keypair;

    const hasWalletDetails =
      fund.pumpPortalWalletPublicKey &&
      fund.pumpPortalWalletPublicKey.length > 0 &&
      fund.pumpPortalPrivateKey &&
      fund.pumpPortalPrivateKey.length > 0 &&
      fund.pumpPortalApiKey &&
      fund.pumpPortalApiKey.length > 0;

    if (!hasWalletDetails) {
      const walletResponse = await fetchWithRetry("https://pumpportal.fun/api/create-wallet", { method: "GET" });
      const walletData = await walletResponse.json();
      apiKey = walletData.apiKey;
      walletPublicKey = walletData.walletPublicKey;
      privateKey = walletData.privateKey;
      pumpWalletKeypair = Keypair.fromSecretKey(bs58.decode(privateKey));

      fund.pumpPortalWalletPublicKey = walletPublicKey;
      fund.pumpPortalPrivateKey = privateKey;
      fund.pumpPortalApiKey = apiKey;
      await fund.save();
      console.log(`Created and saved PumpPortal wallet details to fund ${fundId}: publicKey=${walletPublicKey}`);
    } else {
      walletPublicKey = fund.pumpPortalWalletPublicKey;
      privateKey = fund.pumpPortalPrivateKey;
      apiKey = fund.pumpPortalApiKey;
      pumpWalletKeypair = Keypair.fromSecretKey(bs58.decode(privateKey));
      console.log(`Reusing existing PumpPortal wallet for fund ${fundId}: publicKey=${walletPublicKey}`);
    }

    if (!imageUrl) throw new Error("Image URL is missing");
    let fullImageUrl = imageUrl.startsWith("http") ? imageUrl : `https://res.cloudinary.com/${config.CLOUDINARY_CLOUD_NAME}/image/upload/${imageUrl}`;
    console.log(`Fetching image from: ${fullImageUrl}`);
    const imageResponse = await fetchWithRetry(fullImageUrl, {});
    const imageBlob = await imageResponse.blob();

    const formData = new FormData();
    formData.append("file", imageBlob, `${tokenName.toLowerCase().replace(/\s+/g, "-")}-image.png`);
    formData.append("name", tokenName);
    formData.append("symbol", tokenSymbol);
    formData.append("description", `Crowdfunded token: ${tokenName}`);
    formData.append("twitter", fund.tokenTwitter || "");
    formData.append("telegram", fund.tokenTelegram || "");
    formData.append("website", fund.tokenWebsite || "");
    formData.append("showName", "true");

    const metadataResponse = await fetchWithRetry("https://pump.fun/api/ipfs", {
      method: "POST",
      body: formData,
    });
    const metadataResponseJSON = await metadataResponse.json();
    const metadataUri = metadataResponseJSON.metadataUri;
    console.log(`Metadata prepared for ${tokenName}: ${metadataUri}`);

    // Step 1: Transfer SOL to Pump Wallet
    const pumpWalletBalance = await getBalance(pumpWalletKeypair.publicKey);
    console.log(`Pump wallet balance before transfer: ${pumpWalletBalance} SOL (pubkey: ${pumpWalletKeypair.publicKey.toBase58()})`);

    const donatedSol = fund.currentDonatedSol || totalSolToTransfer;
    const fundWalletBalance = await getBalance(fundWallet.publicKey);
    const { solForCreation, totalSolForPump, feeRaiseWallet } = calculateSolForPump(donatedSol, initialFeePaid,targetSol);
    const maxTransfer = fundWalletBalance - feeRaiseWallet;
    console.log(`Using ${solForCreation} SOL for creation and ${initialFeePaid - feeRaiseWallet} SOL for gas, total SOL for pump wallet: ${totalSolForPump} SOL, leaving ${feeRaiseWallet} SOL in fund wallet`);

    // sometimes pumpWalletBalance is greater than totalSolForPump as in decimal
    const solBuffer = 0.09;
    if (!fund.pumpPortalTransferCompleted && pumpWalletBalance < ( totalSolForPump - solBuffer) ) {      
      console.log(`Fund wallet balance: ${fundWalletBalance} SOL`);
      
      const transferAmount = maxTransfer;
      if (transferAmount <= 0 || fundWalletBalance < transferAmount) {
        throw new Error(`Insufficient funds in fundWallet: ${fundWalletBalance} SOL, need at least ${transferAmount + feeRaiseWallet} SOL`);
      }
      console.log(`Transferring ${transferAmount} SOL from fund wallet ${fundWallet.publicKey.toBase58()} to pump wallet ${pumpWalletKeypair.publicKey.toBase58()}`);
      const transferSignature = await transferSol(fundWallet, pumpWalletKeypair.publicKey, transferAmount);
      await confirmTransaction(transferSignature);
      console.log(`SOL transfer confirmed: ${transferSignature}, transferred ${transferAmount} SOL`);

      // Verify transfer with retries
      await waitWithRetries(
        () => getBalance(pumpWalletKeypair.publicKey),
        balance => balance >= pumpWalletBalance + transferAmount, // Check increase, not absolute
        `SOL transfer verification to pump wallet ${pumpWalletKeypair.publicKey.toBase58()}`
      );

      fund.pumpPortalTransferCompleted = true;
      await fund.save();
      console.log(`Updated fund ${fundId} with transfer completed`);
    } else {
      console.log(`Transfer already completed or sufficient SOL in Pump wallet: ${pumpWalletBalance} SOL`);
    }

    const updatedPumpWalletBalance = await getBalance(pumpWalletKeypair.publicKey);
    console.log(`Pump wallet balance before creation: ${updatedPumpWalletBalance} SOL`);
    if (updatedPumpWalletBalance < ( totalSolForPump - solBuffer)) {
      throw new Error(`Insufficient SOL in pump wallet for updatedPumpWalletBalance: ${updatedPumpWalletBalance} SOL, need ${totalSolForPump} SOL, dev buy ${solForCreation}`);
    }

    // Step 2: Token Creation
    const mintKeypair = Keypair.generate();
    const createPayload = {
      action: "create",
      tokenMetadata: {
        name: metadataResponseJSON.metadata.name,
        symbol: metadataResponseJSON.metadata.symbol,
        uri: metadataResponseJSON.metadataUri,
      },
      mint: bs58.encode(mintKeypair.secretKey),
      denominatedInSol: "true",
      amount: solForCreation, // Use only solForCreation for creation
      slippage: 10,
      priorityFee: 0.005,
      pool: "pump",
    };
    console.log("Sending create payload to Pump.fun (Lightning):", createPayload);

    const createResponse = await fetchWithRetry(`https://pumpportal.fun/api/trade?api-key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(createPayload),
    });

    const responseData = await createResponse.json();
    const signature = responseData.signature;
    const cluster = config.SOLANA_NETWORK === "mainnet" ? "" : "?cluster=devnet";
    const solscanUrl = `https://solscan.io/tx/${signature}${cluster}`;
    console.log(`Token creation transaction sent: ${solscanUrl}`);
    const tokenAddress = responseData.mint || mintKeypair.publicKey.toBase58();

    await waitWithRetries(
      () => connection.getParsedAccountInfo(new PublicKey(tokenAddress), "confirmed"),
      (accountInfo): boolean => {
        if (!accountInfo.value || !("parsed" in accountInfo.value.data)) {
          console.log(`Account info for ${tokenAddress} not yet parsed or invalid:`, accountInfo.value);
          return false;
        }
        const parsedData = accountInfo.value.data as ParsedAccountData;
        const supply = parsedData.parsed.info.supply;
        return supply !== undefined && Number(supply) > 0;
      },
      `Token creation verification for ${tokenAddress}`
    );
    console.log(`Token created and verified: ${tokenAddress}`);

    const totalSupply = 1_000_000_000 * 10 ** 6;
    const pumpWalletBalanceAfter = await getBalance(pumpWalletKeypair.publicKey);
    console.log(`Pump wallet balance after creation: ${pumpWalletBalanceAfter} SOL`);

    // Step 3: Token Transfer to Target Wallet
    const pumpTokenAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      pumpWalletKeypair,
      new PublicKey(tokenAddress),
      pumpWalletKeypair.publicKey
    );
    console.log(`Pump wallet ATA: ${pumpTokenAccount.address.toBase58()}`);

    const targetTokenAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      pumpWalletKeypair,
      new PublicKey(tokenAddress),
      targetWallet
    );
    console.log(`Target wallet ATA: ${targetTokenAccount.address.toBase58()}`);

    let boughtAmount = await waitWithRetries(
      () => connection.getTokenAccountBalance(pumpTokenAccount.address, "confirmed"),
      balance => !!balance.value && balance.value.uiAmount !== null && balance.value.uiAmount > 0,
      `Token balance verification for pump wallet ATA ${pumpTokenAccount.address.toBase58()}`
    );

    const transferAmount = Math.min(Number(boughtAmount.value.amount), totalSupply * (targetPercentage / 100));
    const expectedAmount = totalSupply * (targetPercentage / 100);
    if (transferAmount !== expectedAmount) {
      console.log(`Token transfer adjusted: expected ${expectedAmount / 10 ** 6}, transferring ${transferAmount / 10 ** 6}`);
    }

    await transfer(
      connection,
      pumpWalletKeypair,
      pumpTokenAccount.address,
      targetTokenAccount.address,
      pumpWalletKeypair,
      transferAmount
    );
    console.log(`Token transfer initiated: ${transferAmount / 10 ** 6} ${tokenSymbol} to ${targetWallet.toBase58()}`);

    await waitWithRetries(
      () => connection.getTokenAccountBalance(targetTokenAccount.address, "confirmed"),
      balance => !!balance.value && balance.value.amount === transferAmount.toString(),
      `Token transfer verification to target wallet ATA ${targetTokenAccount.address.toBase58()}`
    );
    console.log(`Transferred and verified ${transferAmount / 10 ** 6} ${tokenSymbol} to ${targetWallet.toBase58()}`);

    // Cleanup: Transfer excess SOL
    const pumpWalletBalanceFinal = await getBalance(pumpWalletKeypair.publicKey);
    if (pumpWalletBalanceFinal > MIN_EXCESS_THRESHOLD) {
      const websiteWallet = new PublicKey(config.WEBSITE_WALLET);
      const excess = pumpWalletBalanceFinal - 0.001;
      await transferSol(pumpWalletKeypair, websiteWallet, excess);
      console.log(`Transferred ${excess} SOL excess to WEBSITE_WALLET`);
    } else {
      console.log(`No excess SOL to transfer: ${pumpWalletBalanceFinal} SOL remaining`);
    }

    return {
      tokenAddress,
      apiKey,
      walletPublicKey,
      privateKey,
      solscanUrl,
      metadataUri,
    };
  } catch (error) {
    console.error("Failed to create and launch token with Lightning API:", error);
    throw error;
  }
};