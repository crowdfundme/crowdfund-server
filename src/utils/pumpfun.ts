import { Keypair, PublicKey } from "@solana/web3.js";
import { transferSol, getConnection } from "./solana";
import { createMint, mintTo, getOrCreateAssociatedTokenAccount, transfer, getAssociatedTokenAddress } from "@solana/spl-token";
import { VersionedTransaction, Connection, TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";
import { getConfig } from "../config";
import Fund from "../models/Fund";

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



// Real Pump.fun API integration with Cloudinary image (Local Transaction)
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
  fundId: string
): Promise<{ tokenAddress: string; apiKey: string; walletPublicKey: string; privateKey: string }> => {
  console.log("Running pumpfun.ts version: 2025-03-31 (Local Transaction)");
  const config = getConfig();
  const connection = getConnection();
  
  var RPC_ENDPOINT;
  if(config.SOLANA_NETWORK === "mainnet"){
    RPC_ENDPOINT = config.SOLANA_RPC_LIVE_ENDPOINT;
  }else{
    RPC_ENDPOINT = config.SOLANA_RPC_DEV_ENDPOINT;
  }  
  
  const web3Connection = new Connection(RPC_ENDPOINT, "confirmed");
  const GAS_FEE_RESERVE = 0.11;
  const MIN_EXCESS_THRESHOLD = 0.005;  

  try {
    const fund = await Fund.findById(fundId);
    if (!fund) throw new Error(`Fund with ID ${fundId} not found`);

    console.log(`Fund ${fundId} PumpPortal fields:`, {
      publicKey: fund.pumpPortalWalletPublicKey,
      privateKey: fund.pumpPortalPrivateKey,
      apiKey: fund.pumpPortalApiKey,
      transferCompleted: fund.pumpPortalTransferCompleted,
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
      const walletResponse = await fetch("https://pumpportal.fun/api/create-wallet", { method: "GET" });
      if (!walletResponse.ok) throw new Error(`Failed to create PumpPortal wallet: ${walletResponse.statusText}`);
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

    let fullImageUrl = imageUrl.startsWith("http") ? imageUrl : `https://res.cloudinary.com/${config.CLOUDINARY_CLOUD_NAME}/image/upload/${imageUrl}`;
    console.log(`Fetching image from: ${fullImageUrl}`);
    const imageResponse = await fetch(fullImageUrl);
    if (!imageResponse.ok) throw new Error(`Failed to fetch image: ${imageResponse.statusText}`);
    const imageBlob = await imageResponse.blob();

    const formData = new FormData();
    formData.append("file", imageBlob, `${tokenName.toLowerCase().replace(/\s+/g, "-")}-image.png`);
    formData.append("name", tokenName);
    formData.append("symbol", "TF13");
    formData.append("description", `Crowdfunded token: ${tokenName}`);
    formData.append("twitter", "https://twitter.com/example");
    formData.append("telegram", "https://t.me/example");
    formData.append("website", "https://example.com");
    formData.append("showName", "true");

    const metadataResponse = await fetch("https://pump.fun/api/ipfs", {
      method: "POST",
      body: formData,
    });
    if (!metadataResponse.ok) throw new Error(`Failed to upload metadata: ${await metadataResponse.text()}`);
    const metadataResponseJSON = await metadataResponse.json();

    const pumpWalletBalance = await web3Connection.getBalance(pumpWalletKeypair.publicKey) / 1_000_000_000;
    console.log(`Pump wallet balance before transfer: ${pumpWalletBalance} SOL`);
    const requiredSol = totalSolToTransfer + GAS_FEE_RESERVE;
    if (!fund.pumpPortalTransferCompleted && pumpWalletBalance < requiredSol) {
      const transferAmount = requiredSol - pumpWalletBalance + 0.01;
      console.log(`Preparing to transfer ${transferAmount} SOL from fund wallet ${fundWallet.publicKey.toBase58()} to pump wallet ${pumpWalletKeypair.publicKey.toBase58()}`);
      const fundWalletBalance = await web3Connection.getBalance(fundWallet.publicKey) / 1_000_000_000;
      console.log(`Fund wallet balance: ${fundWalletBalance} SOL`);
      if (fundWalletBalance < transferAmount + 0.001) {
        throw new Error(`Insufficient funds in fundWallet: ${fundWalletBalance} SOL, need ${transferAmount + 0.001} SOL`);
      }
      const transferSignature = await transferSol(fundWallet, pumpWalletKeypair.publicKey, transferAmount);
      console.log(`SOL transfer confirmed: ${transferSignature}, transferred ${transferAmount} SOL`);
      fund.pumpPortalTransferCompleted = true;
      await fund.save();
    } else {
      console.log(`Transfer already completed or sufficient SOL in Pump wallet: ${pumpWalletBalance} SOL, skipping transfer`);
    }

    const updatedPumpWalletBalance = await web3Connection.getBalance(pumpWalletKeypair.publicKey) / 1_000_000_000;
    console.log(`Pump wallet balance before creation: ${updatedPumpWalletBalance} SOL`);
    const solForCreation = Math.min(updatedPumpWalletBalance - GAS_FEE_RESERVE, 0.1); // Test with 0.1 SOL
    if (solForCreation <= 0) {
      throw new Error(`Insufficient SOL for creation after reserving gas: ${solForCreation} SOL (balance: ${updatedPumpWalletBalance} SOL)`);
    }
    console.log(`Using ${solForCreation} SOL (${Math.floor(solForCreation * 1_000_000_000)} lamports) for token creation, reserving ${GAS_FEE_RESERVE} SOL for gas`);

    const mintKeypair = Keypair.generate();
    const createPayload = {
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
    };
    console.log("Sending create payload to Pump.fun (Local):", createPayload);

    const createResponse = await fetch("https://pumpportal.fun/api/trade-local", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(createPayload),
    });

    if (!createResponse.ok) {
      const errorText = await createResponse.text();
      console.error(`Pump.fun API error response: ${errorText}`);
      throw new Error(`Failed to create token: ${createResponse.statusText} - ${errorText}`);
    }

    const txData = await createResponse.arrayBuffer();
    const tx = VersionedTransaction.deserialize(new Uint8Array(txData));
    const recentBlockhash = (await web3Connection.getLatestBlockhash("confirmed")).blockhash;
    tx.message.recentBlockhash = recentBlockhash;
    tx.sign([mintKeypair, pumpWalletKeypair]);

    console.log("Transaction instructions:");
    const instructions: TransactionInstruction[] = tx.message.compiledInstructions.map((instr) => {
      const programId = tx.message.staticAccountKeys[instr.programIdIndex];
      const accounts = instr.accountKeyIndexes.map((idx) => tx.message.staticAccountKeys[idx]);
      return new TransactionInstruction({
        programId,
        keys: accounts.map((account) => ({ pubkey: account, isSigner: false, isWritable: false })),
        data: Buffer.from(instr.data),
      });
    });
    instructions.forEach((instr: TransactionInstruction, i: number) => {
      console.log(`Instruction ${i}: programId=${instr.programId.toBase58()}, data=${instr.data.toString('hex')}`);
    });

    const skipPreflight = true;
    console.log("Sending transaction with options:", { skipPreflight, maxRetries: 5 });
    const signature = await web3Connection.sendTransaction(tx, { skipPreflight, maxRetries: 5 });
    await web3Connection.confirmTransaction(signature, "confirmed");
    console.log(`Token created: https://solscan.io/tx/${signature}?cluster=devnet`);
    console.log(`Token mint address: ${mintKeypair.publicKey.toBase58()}`);

    const totalSupply = 1_000_000_000 * 10 ** 6;
    const pumpWalletBalanceAfter = await connection.getBalance(pumpWalletKeypair.publicKey) / 1_000_000_000;
    console.log(`Pump wallet balance after creation: ${pumpWalletBalanceAfter} SOL`);
    if (pumpWalletBalanceAfter >= updatedPumpWalletBalance - 0.05) {
      console.warn(`SOL usage minimal: ${pumpWalletBalanceAfter} SOL remaining of ${updatedPumpWalletBalance} SOL. Checking token supply...`);
      const mintInfo = await connection.getParsedAccountInfo(mintKeypair.publicKey, "confirmed");
      console.log(`Mint info: ${JSON.stringify(mintInfo.value, null, 2)}`);
    }

    const pumpTokenAccountAddress = await getAssociatedTokenAddress(mintKeypair.publicKey, pumpWalletKeypair.publicKey);
    console.log(`Waiting for ATA to propagate: ${pumpTokenAccountAddress.toBase58()}`);
    let boughtAmount;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        boughtAmount = await connection.getTokenAccountBalance(pumpTokenAccountAddress, "confirmed");
        if (!boughtAmount || boughtAmount.value.uiAmount === null || boughtAmount.value.uiAmount === 0) {
          throw new Error(`No tokens received in pump wallet after attempt ${attempt + 1}`);
        }
        console.log(`Tokens received: ${boughtAmount.value.uiAmount} ${tokenSymbol}`);
        break;
      } catch (error) {
        if (attempt < 19) {
          console.log(`Attempt ${attempt + 1}: Waiting for ATA, retrying in 10 seconds...`);
          await new Promise(resolve => setTimeout(resolve, 10000));
          continue;
        }
        console.error(`Failed to retrieve token balance after 20 attempts: ${error instanceof Error ? error.message : "Unknown error"}`);
        throw new Error("Pump.fun failed to mint tokens to ATA");
      }
    }

    if (!boughtAmount) throw new Error("boughtAmount is undefined after retries; token creation failed");

    const targetTokenAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      pumpWalletKeypair,
      mintKeypair.publicKey,
      targetWallet
    );
    const transferAmount = Math.min(Number(boughtAmount.value.amount), totalSupply * (targetPercentage / 100));
    await transfer(
      connection,
      pumpWalletKeypair,
      pumpTokenAccountAddress,
      targetWallet,
      pumpWalletKeypair,
      transferAmount
    );
    console.log(`Transferred ${transferAmount / 10 ** 6} ${tokenSymbol} to ${targetWallet.toBase58()}`);

    const pumpWalletBalanceFinal = await connection.getBalance(pumpWalletKeypair.publicKey) / 1_000_000_000;
    if (pumpWalletBalanceFinal > MIN_EXCESS_THRESHOLD) {
      const websiteWallet = new PublicKey(config.WEBSITE_WALLET);
      await transferSol(pumpWalletKeypair, websiteWallet, pumpWalletBalanceFinal - 0.001);
      console.log(`Transferred ${pumpWalletBalanceFinal - 0.001} SOL excess to WEBSITE_WALLET`);
    } else {
      console.log(`No excess SOL to transfer: ${pumpWalletBalanceFinal} SOL remaining`);
    }

    return {
      tokenAddress: mintKeypair.publicKey.toBase58(),
      apiKey,
      walletPublicKey,
      privateKey,
    };
  } catch (error) {
    console.error("Failed to create and launch token with API (Local):", error);
    if (error instanceof Error && error.name === "SendTransactionError") {
      console.log("Transaction logs:", (error as any).transactionLogs);
    }
    throw error;
  }
};

// Lightning Transaction API integration with refined formula and fix applied
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
): Promise<{ tokenAddress: string; apiKey: string; walletPublicKey: string; privateKey: string }> => {
  console.log("Running pumpfun.ts version: 2025-03-31 (Lightning Transaction)");
  const connection = getConnection();
  const GAS_FEE_RESERVE = 0.05; // Gas for Pump wallet
  const FUND_WALLET_RESERVE = 0.02; // Reserve for fund wallet operations
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
      const walletResponse = await fetch("https://pumpportal.fun/api/create-wallet", { method: "GET" });
      if (!walletResponse.ok) throw new Error(`Failed to create PumpPortal wallet: ${walletResponse.statusText}`);
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

    let fullImageUrl = imageUrl.startsWith("http") ? imageUrl : `https://res.cloudinary.com/${config.CLOUDINARY_CLOUD_NAME}/image/upload/${imageUrl}`;
    console.log(`Fetching image from: ${fullImageUrl}`);
    const imageResponse = await fetch(fullImageUrl);
    if (!imageResponse.ok) throw new Error(`Failed to fetch image: ${imageResponse.statusText}`);
    const imageBlob = await imageResponse.blob();

    const formData = new FormData();
    formData.append("file", imageBlob, `${tokenName.toLowerCase().replace(/\s+/g, "-")}-image.png`);
    formData.append("name", tokenName);
    formData.append("symbol", "TF13");
    formData.append("description", `Crowdfunded token: ${tokenName}`);
    formData.append("twitter", "https://twitter.com/example");
    formData.append("telegram", "https://t.me/example");
    formData.append("website", "https://example.com");
    formData.append("showName", "true");

    const metadataResponse = await fetch("https://pump.fun/api/ipfs", {
      method: "POST",
      body: formData,
    });
    if (!metadataResponse.ok) throw new Error(`Failed to upload metadata: ${await metadataResponse.text()}`);
    const metadataResponseJSON = await metadataResponse.json();

    const pumpWalletBalance = await connection.getBalance(pumpWalletKeypair.publicKey, "finalized") / 1_000_000_000;
    console.log(`Pump wallet balance before transfer: ${pumpWalletBalance} SOL (pubkey: ${pumpWalletKeypair.publicKey.toBase58()})`);

    // Refined formula: Leave some SOL in fund wallet
    const donatedSol = fund.currentDonatedSol || totalSolToTransfer;
    const buffer = donatedSol * 0.1; // 10% of donated SOL
    const solForCreation = donatedSol - buffer; // 99% for token creation
    const requiredPumpSol = solForCreation + GAS_FEE_RESERVE + buffer; // Total for Pump wallet = donatedSol + 0.05 SOL
    console.log(`Using ${solForCreation} SOL from donations for token creation (99% of ${donatedSol}), required for Pump wallet with gas (${GAS_FEE_RESERVE} SOL) and buffer (${buffer} SOL): ${requiredPumpSol} SOL`);

    if (!fund.pumpPortalTransferCompleted && pumpWalletBalance < requiredPumpSol) {
      const fundWalletBalance = await connection.getBalance(fundWallet.publicKey, "finalized") / 1_000_000_000;
      console.log(`Fund wallet balance: ${fundWalletBalance} SOL`);
      const maxTransfer = fundWalletBalance - FUND_WALLET_RESERVE; // Leave 0.02 SOL in fund wallet
      const transferAmount = Math.min(requiredPumpSol - pumpWalletBalance, maxTransfer);
      if (transferAmount <= 0 || fundWalletBalance < FUND_WALLET_RESERVE + 0.001) {
        throw new Error(`Insufficient funds in fundWallet: ${fundWalletBalance} SOL, need at least ${FUND_WALLET_RESERVE + 0.001} SOL`);
      }
      console.log(`Preparing to transfer ${transferAmount} SOL from fund wallet ${fundWallet.publicKey.toBase58()} to pump wallet ${pumpWalletKeypair.publicKey.toBase58()}`);
      const transferSignature = await transferSol(fundWallet, pumpWalletKeypair.publicKey, transferAmount);
      await connection.confirmTransaction(transferSignature, "finalized");
      console.log(`SOL transfer confirmed: ${transferSignature}, transferred ${transferAmount} SOL, leaving ${fundWalletBalance - transferAmount} SOL in fund wallet`);
      fund.pumpPortalTransferCompleted = true;
      await fund.save();

      // Add a small delay to ensure balance propagates
      await new Promise(resolve => setTimeout(resolve, 2000));
    } else {
      console.log(`Transfer already completed or sufficient SOL in Pump wallet: ${pumpWalletBalance} SOL, skipping transfer`);
    }

    const updatedPumpWalletBalance = await connection.getBalance(pumpWalletKeypair.publicKey, "finalized") / 1_000_000_000;
    console.log(`Pump wallet balance before creation: ${updatedPumpWalletBalance} SOL (pubkey: ${pumpWalletKeypair.publicKey.toBase58()})`);
    if (updatedPumpWalletBalance < solForCreation + GAS_FEE_RESERVE) {
      throw new Error(`Insufficient SOL in pump wallet for creation: ${updatedPumpWalletBalance} SOL, need ${solForCreation + GAS_FEE_RESERVE} SOL`);
    }

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
      amount: solForCreation,
      slippage: 10,
      priorityFee: 0.0005,
      pool: "pump",
    };
    console.log("Sending create payload to Pump.fun (Lightning):", createPayload);

    const createResponse = await fetch(`https://pumpportal.fun/api/trade?api-key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(createPayload),
    });

    if (!createResponse.ok) {
      const errorText = await createResponse.text();
      console.error(`Pump.fun Lightning API error response: ${errorText}`);
      throw new Error(`Failed to create token with Lightning API: ${createResponse.statusText} - ${errorText}`);
    }

    const responseData = await createResponse.json();
    const signature = responseData.signature;
    console.log(`Token created: https://solscan.io/tx/${signature}?cluster=devnet`);
    const tokenAddress = responseData.mint || mintKeypair.publicKey.toBase58();
    console.log(`Token mint address: ${tokenAddress}`);

    const totalSupply = 1_000_000_000 * 10 ** 6;
    const pumpWalletBalanceAfter = await connection.getBalance(pumpWalletKeypair.publicKey, "finalized") / 1_000_000_000;
    console.log(`Pump wallet balance after creation: ${pumpWalletBalanceAfter} SOL`);
    if (pumpWalletBalanceAfter >= updatedPumpWalletBalance - 0.05) {
      console.warn(`SOL usage minimal: ${pumpWalletBalanceAfter} SOL remaining of ${updatedPumpWalletBalance} SOL. Checking token supply...`);
      const mintInfo = await connection.getParsedAccountInfo(new PublicKey(tokenAddress), "confirmed");
      console.log(`Mint info: ${JSON.stringify(mintInfo.value, null, 2)}`);
    }

    const pumpTokenAccountAddress = await getAssociatedTokenAddress(new PublicKey(tokenAddress), pumpWalletKeypair.publicKey);
    console.log(`Waiting for ATA to propagate: ${pumpTokenAccountAddress.toBase58()}`);
    let boughtAmount;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        boughtAmount = await connection.getTokenAccountBalance(pumpTokenAccountAddress, "confirmed");
        if (!boughtAmount || boughtAmount.value.uiAmount === null || boughtAmount.value.uiAmount === 0) {
          throw new Error(`No tokens received in pump wallet after attempt ${attempt + 1}`);
        }
        console.log(`Tokens received: ${boughtAmount.value.uiAmount} ${tokenSymbol}`);
        break;
      } catch (error) {
        if (attempt < 19) {
          console.log(`Attempt ${attempt + 1}: Waiting for ATA, retrying in 10 seconds...`);
          await new Promise(resolve => setTimeout(resolve, 10000));
          continue;
        }
        console.error(`Failed to retrieve token balance after 20 attempts: ${error instanceof Error ? error.message : "Unknown error"}`);
        throw new Error("Pump.fun Lightning failed to mint tokens to ATA");
      }
    }

    if (!boughtAmount) throw new Error("boughtAmount is undefined after retries; token creation failed");

    const targetTokenAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      pumpWalletKeypair,
      new PublicKey(tokenAddress),
      targetWallet
    );
    const transferAmount = Math.min(Number(boughtAmount.value.amount), totalSupply * (targetPercentage / 100));
    await transfer(
      connection,
      pumpWalletKeypair,
      pumpTokenAccountAddress,
      targetTokenAccount.address,
      pumpWalletKeypair,
      transferAmount
    );
    console.log(`Transferred ${transferAmount / 10 ** 6} ${tokenSymbol} to ${targetWallet.toBase58()}`);

    const pumpWalletBalanceFinal = await connection.getBalance(pumpWalletKeypair.publicKey, "finalized") / 1_000_000_000;
    if (pumpWalletBalanceFinal > MIN_EXCESS_THRESHOLD) {
      const websiteWallet = new PublicKey(config.WEBSITE_WALLET);
      await transferSol(pumpWalletKeypair, websiteWallet, pumpWalletBalanceFinal - 0.001);
      console.log(`Transferred ${pumpWalletBalanceFinal - 0.001} SOL excess to WEBSITE_WALLET`);
    } else {
      console.log(`No excess SOL to transfer: ${pumpWalletBalanceFinal} SOL remaining`);
    }

    return {
      tokenAddress,
      apiKey,
      walletPublicKey,
      privateKey,
    };
  } catch (error) {
    console.error("Failed to create and launch token with Lightning API:", error);
    throw error;
  }
};