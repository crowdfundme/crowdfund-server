import express from "express";
import User from "../models/User";
import Fund from "../models/Fund";
import { generateWallet, getBalance, transferSol, verifySolPayment, getConnection } from "../utils/solana";
import { createAndLaunchTokenWithLightning } from "../utils/pumpfun";
import { PublicKey, Keypair, Transaction, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { asyncHandler } from "../utils/asyncHandler";
import { getConfig } from "../config";
import { getOrCreateAssociatedTokenAccount, transfer, getAssociatedTokenAddress } from "@solana/spl-token";
import * as bs58 from "bs58";
import { logInfo, logError } from "../utils/logger";

const router = express.Router();

// Define the type for targetSolMap explicitly
const targetSolMap: { [key: number]: number } = {
  1: 0.3,
  5: 1.480938417,
  10: 3.114080165,
  25: 9.204131229,
  50: 26.439790577,
  75: 70.356037153,
};

// Valid target percentages
const validTargetPercentages = [1, 5, 10, 25, 50, 75] as const;
type TargetPercentage = typeof validTargetPercentages[number];

// Load WEBSITE_WALLET keypair at startup
const config = getConfig();
const websiteWallet = config.WEBSITE_WALLET_KEYPAIR.publicKey;
const websiteWalletKeypair = config.WEBSITE_WALLET_KEYPAIR;

router.get(
  "/fee",
  asyncHandler(async (req, res) => {
    logInfo(`GET /funds/fee - Request from ${req.ip} at ${new Date().toISOString()} - Returning fee values:`, {
      creationFee: config.CROWD_FUND_CREATION_FEE,
      minDonation: config.MIN_DONATION,
      maxDonation: config.MAX_DONATION,
    });

    res.json({
      creationFee: config.CROWD_FUND_CREATION_FEE,
      minDonation: config.MIN_DONATION,
      maxDonation: config.MAX_DONATION,
    });
  })
);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const {
      userWallet,
      name,
      image,
      tokenName,
      tokenSymbol,
      tokenDescription,
      targetPercentage,
      targetWallet,
      tokenTwitter,
      tokenTelegram,
      tokenWebsite,
      txSignature,
    } = req.body;

    if (
      !userWallet ||
      !name ||
      !tokenName ||
      !tokenSymbol ||
      !tokenDescription ||
      !targetPercentage ||
      !targetWallet ||
      !txSignature
    ) {
      return res.status(400).json({ error: "Required fields are missing, including transaction signature" });
    }

    const parsedTargetPercentage = Number(targetPercentage);
    if (!validTargetPercentages.includes(parsedTargetPercentage as TargetPercentage)) {
      return res.status(400).json({ error: "Invalid targetPercentage. Must be one of: 1, 5, 10, 25, 50, 75" });
    }
    const typedTargetPercentage = parsedTargetPercentage as TargetPercentage;

    let user = await User.findOne({ walletAddress: userWallet });
    if (!user) {
      user = new User({ walletAddress: userWallet });
      await user.save();
    }

    const fundWallet = generateWallet();

    // Verify the 0.1 SOL payment to WEBSITE_WALLET
    const paymentValid = await verifySolPayment(
      txSignature,
      userWallet,
      websiteWallet.toBase58(),
      config.CROWD_FUND_CREATION_FEE
    );
    if (!paymentValid) {
      return res.status(400).json({
        error: `Transaction does not contain valid SOL transfer of ${config.CROWD_FUND_CREATION_FEE} SOL to ${websiteWallet.toBase58()}`,
      });
    }

    const connection = getConnection();
    await connection.confirmTransaction(txSignature, "confirmed");

    // Create the fund
    const fund = new Fund({
      userId: user._id,
      name,
      image,
      fundWalletAddress: fundWallet.publicKey.toBase58(),
      fundPrivateKey: bs58.default.encode(fundWallet.secretKey), // Store as base58 string
      tokenName,
      tokenSymbol,
      tokenDescription,
      targetPercentage: typedTargetPercentage,
      targetSolAmount: targetSolMap[typedTargetPercentage],
      targetWallet,
      tokenTwitter,
      tokenTelegram,
      tokenWebsite,
      launchFee: config.CROWD_FUND_CREATION_FEE,
      initialFeePaid: 0, // Will be updated after transfer
    });

    await fund.save();

    // Transfer 0.099 SOL (99% of 0.1 SOL) from WEBSITE_WALLET to fundWalletAddress
    const websiteBalance = await getBalance(websiteWalletKeypair.publicKey, "confirmed");
    const transferAmount = config.CROWD_FUND_CREATION_FEE * 0.99; // 0.099 SOL
    if (websiteBalance < transferAmount + 0.005) {
      await Fund.findByIdAndDelete(fund._id);
      return res.status(500).json({
        error: `Insufficient balance in WEBSITE_WALLET: ${websiteBalance} SOL available, need ${transferAmount + 0.005} SOL`,
      });
    }

    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: websiteWalletKeypair.publicKey,
        toPubkey: fundWallet.publicKey,
        lamports: transferAmount * LAMPORTS_PER_SOL,
      })
    );
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = websiteWalletKeypair.publicKey;

    const transferSignature = await connection.sendTransaction(transaction, [websiteWalletKeypair], {
      skipPreflight: true,
    });
    await connection.confirmTransaction(transferSignature, "confirmed");

    logInfo(
      `Transferred ${transferAmount} SOL from ${websiteWallet.toBase58()} to ${fund.fundWalletAddress} - Tx: ${transferSignature}`
    );

    // Update initialFeePaid with the amount transferred to fundWalletAddress
    fund.initialFeePaid = transferAmount;
    await fund.save();

    res.status(201).json({
      ...fund.toJSON(),
      message: `Fund created and ${transferAmount} SOL transferred to fund wallet. Transaction signature: ${transferSignature}`,
    });
  })
);

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { status } = req.query;

    if (status && !["active", "completed"].includes(status as string)) {
      return res.status(400).json({ error: "Invalid status parameter. Must be 'active' or 'completed'." });
    }

    const query = status ? { status } : {};
    const funds = await Fund.find(query).populate("userId", "walletAddress");

    for (const fund of funds) {
      logInfo(
        `GET /funds - Fund ${fund._id}: currentDonatedSol=${fund.currentDonatedSol}, initialFeePaid=${fund.initialFeePaid}`
      );
    }

    res.json(funds);
  })
);

router.post(
  "/:id/donate",
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { amount, donorWallet, txSignature } = req.body;

    const GAS_FEE_RESERVE = 0.05; // Aligned with pumpfun.ts
    const connection = getConnection();

    if (!donorWallet || !txSignature) {
      return res.status(400).json({ error: "Donor wallet address and transaction signature are required" });
    }

    if (amount < config.MIN_DONATION || amount > config.MAX_DONATION) {
      return res.status(400).json({
        error: `Donation amount must be between ${config.MIN_DONATION} and ${config.MAX_DONATION} SOL`,
      });
    }

    const fund = await Fund.findById(id);
    if (!fund || fund.status === "completed") {
      return res.status(400).json({ error: "Invalid fund" });
    }
    if (fund.initialFeePaid === 0) {
      return res.status(400).json({ error: "Creation fee not yet paid. Please pay the creation fee first." });
    }

    const paymentValid = await verifySolPayment(txSignature, donorWallet, fund.fundWalletAddress, amount);
    if (!paymentValid) {
      return res.status(400).json({
        error: `Transaction does not contain valid SOL transfer of ${amount} SOL from ${donorWallet} to ${fund.fundWalletAddress}`,
      });
    }

    await connection.confirmTransaction(txSignature, "finalized");
    logInfo(`Donation transaction ${txSignature} confirmed for fund ${id}`);

    const balance = await getBalance(new PublicKey(fund.fundWalletAddress), "finalized");
    const newCurrentDonatedSol = Math.max(0, balance - fund.initialFeePaid);
    logInfo(`Fund ${id} balance after donation: ${balance} SOL, currentDonatedSol updated to ${newCurrentDonatedSol} SOL`);

    fund.currentDonatedSol = newCurrentDonatedSol;

    let donor = await User.findOne({ walletAddress: donorWallet });
    if (!donor) {
      donor = new User({ walletAddress: donorWallet });
    }
    donor.donations.push({
      fundId: fund._id,
      amount,
      donatedAt: new Date(),
    });
    donor.totalDonatedSol = (donor.totalDonatedSol || 0) + amount;
    await donor.save();

    const totalTarget = fund.targetSolAmount;
    if (fund.currentDonatedSol >= totalTarget) {
      fund.status = "completed";
      fund.completedAt = new Date();
      logInfo(`Fund ${fund._id} reached target: ${fund.currentDonatedSol} SOL >= ${totalTarget} SOL`);

      const expectedBalance = fund.initialFeePaid + fund.currentDonatedSol;
      if (balance < expectedBalance - 0.005) {
        logError(`Balance mismatch for fund ${id}: actual=${balance} SOL, expected=${expectedBalance} SOL`);
        throw new Error(`Fund wallet balance (${balance} SOL) is less than expected (${expectedBalance} SOL)`);
      } else if (balance < expectedBalance) {
        logInfo(`Minor balance discrepancy for fund ${id}: actual=${balance} SOL, expected=${expectedBalance} SOL`);
      }

      const fundWallet = Keypair.fromSecretKey(bs58.default.decode(fund.fundPrivateKey));
      const donatedSol = fund.currentDonatedSol;
      const buffer = donatedSol * 0.1; // 10% buffer
      const totalSolToTransfer = donatedSol + fund.initialFeePaid - buffer - GAS_FEE_RESERVE;
      if (totalSolToTransfer <= 0) {
        throw new Error(`Insufficient funds after reserving gas and buffer: ${totalSolToTransfer} SOL`);
      }

      await fund.save();
      logInfo(`Fund ${fund._id} saved as completed before token creation`);

      try {
        const { tokenAddress, apiKey, walletPublicKey, privateKey, solscanUrl } = await createAndLaunchTokenWithLightning(
          fundWallet,
          fund.tokenName,
          fund.tokenSymbol,
          fund.targetSolAmount,
          new PublicKey(fund.targetWallet),
          fund.initialFeePaid,
          fund.targetPercentage,
          fund.image || "", // Default to empty string if image is missing
          totalSolToTransfer,
          fund._id.toString()
        );

        fund.tokenAddress = tokenAddress;
        fund.pumpPortalApiKey = apiKey;
        fund.pumpPortalWalletPublicKey = walletPublicKey;
        fund.pumpPortalPrivateKey = privateKey;
        fund.solscanUrl = solscanUrl;
        logInfo(`Assigned solscanUrl to fund: ${fund.solscanUrl}`);
      } catch (error: unknown) {
        logError(`Token creation or transfer failed for fund ${fund._id}:`, error);
        fund.launchError = error instanceof Error ? error.message : "Unknown error during token creation/transfer";
      }

      try {
        await fund.save();
      } catch (saveErr) {
        logError(`Failed to save fund ${fund._id} after token launch:`, saveErr);
        throw new Error("Database save failed after token creation");
      }
    } else {
      await fund.save();
    }

    res.json({ ...fund.toJSON(), signature: txSignature });
  })
);

router.post(
  "/:id/transfer",
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { userWallet } = req.body;

    if (!userWallet) {
      return res.status(400).json({ error: "User wallet address is required" });
    }

    const fund = await Fund.findById(id).populate("userId", "walletAddress");
    if (!fund) {
      return res.status(404).json({ error: "Fund not found" });
    }

    if (fund.userId.walletAddress !== userWallet) {
      return res.status(403).json({ error: "Only the fund creator can trigger this transfer" });
    }

    if (fund.status !== "completed" || !fund.tokenAddress) {
      return res.status(400).json({ error: "Fund must be completed and have a token address to transfer" });
    }

    if (!fund.pumpPortalPrivateKey || !fund.pumpPortalWalletPublicKey) {
      return res.status(400).json({ error: "Pump.fun wallet details are missing" });
    }

    const connection = getConnection();
    const pumpWalletKeypair = Keypair.fromSecretKey(bs58.default.decode(fund.pumpPortalPrivateKey));
    const tokenMint = new PublicKey(fund.tokenAddress);
    const targetWallet = new PublicKey(fund.targetWallet);

    const pumpTokenAccountAddress = await getAssociatedTokenAddress(tokenMint, pumpWalletKeypair.publicKey);
    const targetTokenAccountAddress = await getAssociatedTokenAddress(tokenMint, targetWallet);

    logInfo(`Checking target wallet ATA: ${targetTokenAccountAddress.toBase58()}`);
    let targetBalance;
    try {
      targetBalance = await connection.getTokenAccountBalance(targetTokenAccountAddress, "confirmed");
      if (targetBalance.value.uiAmount !== null && targetBalance.value.uiAmount > 0) {
        logInfo(`Tokens already transferred to ${targetWallet.toBase58()}: ${targetBalance.value.uiAmount} tokens`);
        fund.launchError = null;
        await fund.save();
        return res.json({
          message: `Tokens already transferred to ${targetWallet.toBase58()}. Amount: ${targetBalance.value.uiAmount} tokens`,
        });
      }
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        (err.name === "TokenAccountNotFoundError" || err.message.includes("could not find account"))
      ) {
        logInfo(`No token account found for target wallet: ${targetWallet.toBase58()}`);
      } else {
        logError(`Error checking target wallet balance:`, err);
        throw err;
      }
    }

    logInfo(`Checking Pump.fun wallet ATA: ${pumpTokenAccountAddress.toBase58()}`);
    let pumpBalance;
    try {
      pumpBalance = await connection.getTokenAccountBalance(pumpTokenAccountAddress, "confirmed");
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        (err.name === "TokenAccountNotFoundError" || err.message.includes("could not find account"))
      ) {
        logInfo(`No token account found for Pump.fun wallet: ${pumpWalletKeypair.publicKey.toBase58()}`);
        return res.status(400).json({
          error: "No tokens found in Pump.fun wallet. They may have been transferred or never deposited.",
        });
      }
      logError(`Error checking Pump.fun wallet balance:`, err);
      throw err;
    }

    if (!pumpBalance || (pumpBalance.value.uiAmount !== null && pumpBalance.value.uiAmount === 0)) {
      return res.status(400).json({ error: "No tokens available in Pump.fun wallet to transfer" });
    }

    const targetTokenAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      pumpWalletKeypair,
      tokenMint,
      targetWallet
    );

    const transferAmount = Number(pumpBalance.value.amount);
    const signature = await transfer(
      connection,
      pumpWalletKeypair,
      pumpTokenAccountAddress,
      targetTokenAccount.address,
      pumpWalletKeypair,
      transferAmount
    );

    logInfo(`Manually transferred ${transferAmount / 10 ** 6} tokens to ${targetWallet.toBase58()} for fund ${id}`);
    fund.launchError = null;
    await fund.save();

    res.json({
      message: `Successfully transferred ${transferAmount / 10 ** 6} tokens to ${targetWallet.toBase58()}`,
      signature,
    });
  })
);

router.post(
  "/:id/launch",
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { userWallet } = req.body;

    if (!userWallet) {
      return res.status(400).json({ error: "User wallet address is required" });
    }

    const fund = await Fund.findById(id).populate("userId", "walletAddress");
    if (!fund) {
      return res.status(404).json({ error: "Fund not found" });
    }

    if (fund.userId.walletAddress !== userWallet) {
      return res.status(403).json({ error: "Only the fund creator can launch the token" });
    }

    if (fund.status !== "completed") {
      return res.status(400).json({ error: "Fund must be completed to launch the token" });
    }

    if (fund.tokenAddress) {
      return res.status(400).json({ error: "Token already launched" });
    }

    const fundWallet = Keypair.fromSecretKey(bs58.default.decode(fund.fundPrivateKey));
    const totalSolToTransfer = fund.initialFeePaid + fund.currentDonatedSol - 0.05; // GAS_FEE_RESERVE

    if (totalSolToTransfer <= 0) {
      return res.status(400).json({ error: `Insufficient funds after reserving gas: ${totalSolToTransfer} SOL` });
    }

    try {
      const { tokenAddress, apiKey, walletPublicKey, privateKey, solscanUrl } = await createAndLaunchTokenWithLightning(
        fundWallet,
        fund.tokenName,
        fund.tokenSymbol,
        fund.targetSolAmount,
        new PublicKey(fund.targetWallet),
        fund.initialFeePaid,
        fund.targetPercentage,
        fund.image || "",
        totalSolToTransfer,
        fund._id.toString()
      );

      fund.tokenAddress = tokenAddress;
      fund.pumpPortalApiKey = apiKey;
      fund.pumpPortalWalletPublicKey = walletPublicKey;
      fund.pumpPortalPrivateKey = privateKey;
      fund.solscanUrl = solscanUrl;
      logInfo(`Assigned solscanUrl to fund: ${fund.solscanUrl}`);
      fund.launchError = null;
      await fund.save();

      res.json({
        message: `Token launched successfully`,
        tokenAddress,
        signature: `https://solscan.io/tx/${tokenAddress}?cluster=devnet`, // Update with actual signature if available
      });
    } catch (error: unknown) {
      logError(`Manual token creation failed for fund ${id}:`, error);
      fund.launchError = error instanceof Error ? error.message : "Unknown error during manual token creation";
      await fund.save();
      return res.status(500).json({ error: fund.launchError });
    }
  })
);

export default router;