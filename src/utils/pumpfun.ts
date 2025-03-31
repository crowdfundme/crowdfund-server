import { Keypair, PublicKey } from "@solana/web3.js";
import { transferSol, getConnection } from "./solana";
import { createMint, mintTo, getOrCreateAssociatedTokenAccount, transfer } from "@solana/spl-token";
import { VersionedTransaction, Connection } from "@solana/web3.js";
import bs58 from "bs58";
import { getConfig } from "../config";
import Fund from "../models/Fund"; // Import Fund model for DB updates

// Simulated token creation (original method for testing)
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
    const requiredSol = targetSol + 0.01;
    if (balance < requiredSol) {
      throw new Error(`Insufficient funds in fundWallet: ${balance} SOL, required: ${requiredSol} SOL`);
    }

    await transferSol(fundWallet, targetWallet, targetSol);

    const mint = await createMint(connection, fundWallet, fundWallet.publicKey, null, 6);
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

    const totalSupply = 1_000_000_000 * 10 ** 6;
    await mintTo(connection, fundWallet, mint, fundWalletTokenAccount.address, fundWallet.publicKey, totalSupply);

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
        amountToTransfer / 10 ** 6
      } tokens) to ${targetWallet.toBase58()}`
    );
    return mint.toBase58();
  } catch (error) {
    console.error("Failed to create and launch token (simulation):", error);
    throw error;
  }
};

// Real Pump.fun API integration with Cloudinary image
export const createAndLaunchTokenWithApi = async (
  fundWallet: Keypair,
  tokenName: string,
  tokenSymbol: string,
  targetSol: number,
  targetWallet: PublicKey,
  initialFeePaid: number,
  targetPercentage: number,
  imageUrl: string,
  totalSolToTransfer: number,
  fundId: string // Add fundId parameter to identify the fund in the DB
): Promise<{ tokenAddress: string; apiKey: string; walletPublicKey: string; privateKey: string }> => {
  const connection = getConnection();
  const RPC_ENDPOINT = process.env.SOLANA_RPC_ENDPOINT || "https://api.devnet.solana.com";
  const web3Connection = new Connection(RPC_ENDPOINT, "confirmed");
  const GAS_FEE = 0.005;
  const MIN_EXCESS_THRESHOLD = 0.005;
  const config = getConfig();

  try {
    // Step 1: Create a new wallet via PumpPortal API
    const walletResponse = await fetch("https://pumpportal.fun/api/create-wallet", {
      method: "GET",
    });
    if (!walletResponse.ok) throw new Error("Failed to create PumpPortal wallet");
    const walletData = await walletResponse.json();
    const { apiKey, walletPublicKey, privateKey } = walletData;

    const pumpWalletKeypair = Keypair.fromSecretKey(bs58.decode(privateKey));

    // Step 2: Save PumpPortal wallet details to the Fund document
    const fund = await Fund.findById(fundId);
    if (!fund) throw new Error(`Fund with ID ${fundId} not found`);
    fund.pumpPortalWalletPublicKey = walletPublicKey;
    fund.pumpPortalPrivateKey = privateKey; // Note: In production, encrypt this!
    await fund.save();
    console.log(`Saved PumpPortal wallet details to fund ${fundId}: publicKey=${walletPublicKey}`);

    // Step 3: Fetch image from Cloudinary and convert to Blob
    let fullImageUrl = imageUrl;
    if (!imageUrl.startsWith("http")) {
      fullImageUrl = `https://res.cloudinary.com/${config.CLOUDINARY_CLOUD_NAME}/image/upload/${imageUrl}`;
    }
    console.log(`Fetching image from: ${fullImageUrl}`);
    const imageResponse = await fetch(fullImageUrl);
    if (!imageResponse.ok) throw new Error(`Failed to fetch image from Cloudinary: ${imageResponse.statusText}`);
    const imageBlob = await imageResponse.blob();

    // Step 4: Create token metadata with Cloudinary image
    const formData = new FormData();
    formData.append("file", imageBlob, `${tokenName.toLowerCase().replace(/\s+/g, "-")}-image.png`);
    formData.append("name", tokenName);
    formData.append("symbol", tokenSymbol);
    formData.append("description", `Crowdfunded token: ${tokenName}`);
    formData.append("twitter", "https://twitter.com/example");
    formData.append("telegram", "https://t.me/example");
    formData.append("website", "https://example.com");
    formData.append("showName", "true");

    const metadataResponse = await fetch("https://pump.fun/api/ipfs", {
      method: "POST",
      body: formData,
    });
    if (!metadataResponse.ok) throw new Error("Failed to upload metadata to IPFS");
    const metadataResponseJSON = await metadataResponse.json();

    // Step 5: Transfer SOL to Pump.fun wallet and confirm
    const transferSignature = await transferSol(fundWallet, pumpWalletKeypair.publicKey, totalSolToTransfer);
    await web3Connection.confirmTransaction(transferSignature, "confirmed");
    console.log(`SOL transfer confirmed: ${transferSignature}`);

    // Step 6: Create token and buy initial tokens
    const solForCreation = totalSolToTransfer - GAS_FEE;
    const mintKeypair = Keypair.generate();
    const createResponse = await fetch("https://pumpportal.fun/api/trade-local", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        publicKey: walletPublicKey,
        action: "create",
        tokenMetadata: {
          name: metadataResponseJSON.metadata.name,
          symbol: metadataResponseJSON.metadata.symbol,
          uri: metadataResponseJSON.metadataUri,
        },
        mint: mintKeypair.publicKey.toBase58(),
        denominatedInSol: "true",
        amount: solForCreation,
        slippage: 10,
        priorityFee: 0.0005,
        pool: "pump",
      }),
    });

    if (createResponse.status !== 200) {
      throw new Error(`Failed to create token: ${createResponse.statusText}`);
    }

    const rawResponseText = await createResponse.clone().text();
    console.log("Raw response from PumpPortal /api/trade-local:", rawResponseText);

    const txData = await createResponse.arrayBuffer();
    const tx = VersionedTransaction.deserialize(new Uint8Array(txData));
    const recentBlockhash = (await web3Connection.getLatestBlockhash("confirmed")).blockhash;
    tx.message.recentBlockhash = recentBlockhash;
    tx.sign([mintKeypair, pumpWalletKeypair]);
    const signature = await web3Connection.sendTransaction(tx, { skipPreflight: true });
    console.log(`Token created: https://solscan.io/tx/${signature}`);
    console.log(`Token mint address: ${mintKeypair.publicKey.toBase58()}`);

    // Step 7: Transfer targetPercentage of total supply to targetWallet
    const totalSupply = 1_000_000_000 * 10 ** 6;
    const amountToTransfer = totalSupply * (targetPercentage / 100);
    const pumpTokenAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      pumpWalletKeypair,
      mintKeypair.publicKey,
      pumpWalletKeypair.publicKey
    );
    const targetTokenAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      pumpWalletKeypair,
      mintKeypair.publicKey,
      targetWallet
    );

    // Retry logic for token account balance
    let boughtAmount;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        boughtAmount = await connection.getTokenAccountBalance(pumpTokenAccount.address, "confirmed");
        break;
      } catch (error) {
        if (error instanceof Error && error.name === "TokenAccountNotFoundError" && attempt < 2) {
          console.log(`Token account not found on attempt ${attempt + 1}, waiting 2 seconds...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
          continue;
        }
        throw error;
      }
    }

    if (!boughtAmount) {
      throw new Error("Failed to retrieve token account balance after retries");
    }

    console.log(`Tokens received in pump wallet: ${boughtAmount.value.uiAmount ?? "unknown"} tokens`);
    const uiAmount = boughtAmount.value.uiAmount ?? 0;
    if (uiAmount < amountToTransfer / 10 ** 6) {
      console.warn(`Warning: Only ${uiAmount} tokens available, less than ${amountToTransfer / 10 ** 6} requested`);
    }

    const transferAmount = Math.min(amountToTransfer, Number(boughtAmount.value.amount));
    await transfer(
      connection,
      pumpWalletKeypair,
      pumpTokenAccount.address,
      targetTokenAccount.address,
      pumpWalletKeypair,
      transferAmount
    );
    console.log(`Transferred ${transferAmount / 10 ** 6} tokens to ${targetWallet.toBase58()}`);

    // Step 8: Calculate and transfer excess SOL back to WEBSITE_WALLET
    const pumpWalletBalance = await connection.getBalance(pumpWalletKeypair.publicKey) / 1_000_000_000;
    if (pumpWalletBalance > MIN_EXCESS_THRESHOLD) {
      const websiteWallet = new PublicKey(config.WEBSITE_WALLET);
      await transferSol(pumpWalletKeypair, websiteWallet, pumpWalletBalance);
      console.log(`Transferred ${pumpWalletBalance} SOL excess from Pump.fun wallet to WEBSITE_WALLET`);
    } else {
      console.log(`No meaningful excess SOL to transfer: ${pumpWalletBalance} SOL is below threshold of ${MIN_EXCESS_THRESHOLD} SOL`);
    }

    return {
      tokenAddress: mintKeypair.publicKey.toBase58(),
      apiKey,
      walletPublicKey,
      privateKey,
    };
  } catch (error) {
    console.error("Failed to create and launch token with API:", error);
    throw error;
  }
};