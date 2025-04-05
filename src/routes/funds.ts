import express from "express";
import User from "../models/User";
import Fund from "../models/Fund";
import mongoose from "mongoose";
import { generateWallet, getBalance, transferSol, verifySolPayment, getConnection } from "../utils/solana";
import { createAndLaunchTokenWithLightning, createAndLaunchTokenWithLightning2 } from "../utils/pumpfun";
import { PublicKey, Keypair, Transaction, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { asyncHandler } from "../utils/asyncHandler";
import { getConfig } from "../config";
import { getOrCreateAssociatedTokenAccount, transfer, getAssociatedTokenAddress } from "@solana/spl-token";
import * as bs58 from "bs58";
import { logInfo, logError } from "../utils/logger";

interface PQueue {
  add: (fn: () => Promise<void>) => Promise<void>;
  size: number;
}

let donationQueue: PQueue | null = null;
const getDonationQueue = async (): Promise<PQueue> => {
  if (!donationQueue) {
    const { default: PQueue } = await import("p-queue");
    donationQueue = new PQueue({ concurrency: 2 });
    logInfo("Initialized PQueue with concurrency 2");
  }
  return donationQueue;
};

const router = express.Router();

const targetSolMap: { [key: number]: number } = {
  1: 0.3,
  5: 1.480938417,
  10: 3.114080165,
  25: 9.204131229,
  50: 26.439790577,
  75: 70.356037153,
};

const validTargetPercentages = [1, 5, 10, 25, 50, 75] as const;
type TargetPercentage = typeof validTargetPercentages[number];

const config = getConfig();
const websiteWallet = config.WEBSITE_WALLET_KEYPAIR.publicKey;
const websiteWalletKeypair = config.WEBSITE_WALLET_KEYPAIR;

router.get(
  "/fee",
  asyncHandler(async (req, res) => {
    logInfo(`GET /funds/fee - Request from ${req.ip}`, {
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
    console.log("Raw request body:", req.body); // Added for debugging
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

    logInfo(`POST /funds - Creating new fund`, {
      userWallet,
      name,
      tokenName,
      tokenSymbol,
      targetPercentage,
      targetWallet,
      txSignature,
    });

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
      logError(`Missing required fields for fund creation`, req.body);
      return res.status(400).json({ error: "Required fields are missing, including transaction signature" });
    }

    const parsedTargetPercentage = Number(targetPercentage);
    if (!validTargetPercentages.includes(parsedTargetPercentage as TargetPercentage)) {
      logError(`Invalid targetPercentage: ${parsedTargetPercentage}`);
      return res.status(400).json({ error: "Invalid targetPercentage. Must be one of: 1, 5, 10, 25, 50, 75" });
    }
    const typedTargetPercentage = parsedTargetPercentage as TargetPercentage;

    let user = await User.findOne({ walletAddress: userWallet });
    if (!user) {
      user = new User({ walletAddress: userWallet });
      await user.save();
      logInfo(`Created new user: ${userWallet}`);
    }

    const fundWallet = generateWallet();

    logInfo(`Verifying creation fee payment: ${config.CROWD_FUND_CREATION_FEE} SOL from ${userWallet} to ${websiteWallet.toBase58()}`);
    const paymentValid = await verifySolPayment(
      txSignature,
      userWallet,
      websiteWallet.toBase58(),
      config.CROWD_FUND_CREATION_FEE
    );
    if (!paymentValid) {
      logError(`Transaction verification failed for fund creation`, {
        txSignature,
        userWallet,
        expectedReceiver: websiteWallet.toBase58(),
        amount: config.CROWD_FUND_CREATION_FEE,
      });
      return res.status(400).json({
        error: `Transaction does not contain valid SOL transfer of ${config.CROWD_FUND_CREATION_FEE} SOL to ${websiteWallet.toBase58()}`,
      });
    }

    const connection = getConnection();
    await connection.confirmTransaction(txSignature, "confirmed");
    logInfo(`Creation fee transaction confirmed: ${txSignature}`);

    const fund = new Fund({
      userId: user._id,
      name,
      image, // May be undefined if not provided initially
      fundWalletAddress: fundWallet.publicKey.toBase58(),
      fundPrivateKey: bs58.default.encode(fundWallet.secretKey),
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
      initialFeePaid: 0,
    });

    await fund.save();
    logInfo(`Fund created: ${fund._id}`);

    const websiteBalance = await getBalance(websiteWalletKeypair.publicKey);
    const transferAmount = config.CROWD_FUND_CREATION_FEE * 0.99;
    if (websiteBalance < transferAmount + 0.005) {
      await Fund.findByIdAndDelete(fund._id);
      logError(`Insufficient balance in WEBSITE_WALLET`, { balance: websiteBalance, required: transferAmount + 0.005 });
      return res.status(500).json({
        error: `Insufficient balance in WEBSITE_WALLET: ${websiteBalance} SOL available, need ${transferAmount + 0.005} SOL`,
      });
    }

    const transferSignature = await transferSol(websiteWalletKeypair, fundWallet.publicKey, transferAmount);
    logInfo(`Transferred ${transferAmount} SOL from ${websiteWallet.toBase58()} to ${fund.fundWalletAddress}`, { tx: transferSignature });

    fund.initialFeePaid = transferAmount;
    await fund.save();

    res.status(201).json({
      ...fund.toJSON(),
      message: `Fund created and ${transferAmount} SOL transferred to fund wallet. Transaction signature: ${transferSignature}`,
    });
    logInfo(`Fund creation completed: ${fund._id}`);
  })
);

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { status = "active", page = "1", limit = "10", search } = req.query;

    logInfo(`GET /funds - Fetching funds`, { status, page, limit, search });

    if (status && !["active", "completed"].includes(status as string)) {
      logError(`Invalid status parameter: ${status}`);
      return res.status(400).json({ error: "Invalid status parameter. Must be 'active' or 'completed'." });
    }

    const pageNum = parseInt(page as string, 10);
    const limitNum = parseInt(limit as string, 10);
    if (isNaN(pageNum) || isNaN(limitNum) || pageNum < 1 || limitNum < 1) {
      logError(`Invalid pagination parameters`, { page, limit });
      return res.status(400).json({ error: "Page and limit must be positive integers." });
    }

    const query: any = { status };
    logInfo(`Query constructed`, { query });

    if (search && typeof search === "string") {
      const normalizedSearch = search.trim().replace(/\s+/g, " ");
      const escapedSearch = normalizedSearch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const searchRegex = new RegExp(escapedSearch, "i");

      query.$or = [
        { _id: mongoose.Types.ObjectId.isValid(normalizedSearch) ? normalizedSearch : null },
        { name: searchRegex },
        { tokenName: searchRegex },
        { tokenSymbol: searchRegex },
      ].filter((condition) => condition !== null);

      logInfo(`Searching funds with normalized term: "${normalizedSearch}"`);
    }

    logInfo(`Executing Fund.find with query`, { query });

    const totalInDb = await Fund.countDocuments(query);
    logInfo(`Total funds in DB matching query`, { total: totalInDb });

    const funds = await Fund.find(query)
      .sort(status === "completed" ? { completedAt: -1 } : { createdAt: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .populate("userId", "walletAddress");

    logInfo(`Fetched funds from DB`, { count: funds.length, page: pageNum, limit: limitNum });

    if (funds.length > limitNum) {
      logError(`Fetched more funds than limit`, { fetched: funds.length, limit: limitNum });
    }

    const totalFunds = await Fund.countDocuments(query);
    logInfo(`Found ${funds.length} funds of ${totalFunds} total for status=${status}, page=${pageNum}`);

    funds.forEach((fund) => {
      logInfo(`Fund in response`, {
        id: fund._id,
        status: fund.status,
        currentDonatedSol: fund.currentDonatedSol,
        targetSolAmount: fund.targetSolAmount,
        completedAt: fund.completedAt,
      });
    });

    const fundsWithBalances = await Promise.all(
      funds.map(async (fund) => {
        try {
          const balance = await getBalance(new PublicKey(fund.fundWalletAddress));
          const fundJson = fund.toJSON();
          delete fundJson.fundPrivateKey;
          delete fundJson.pumpPortalPrivateKey;
          return { ...fundJson, currentBalance: balance };
        } catch (error) {
          logError(`Failed to fetch balance for fund ${fund._id}`, error);
          const fundJson = fund.toJSON();
          delete fundJson.fundPrivateKey;
          delete fundJson.pumpPortalPrivateKey;
          return { ...fundJson, currentBalance: null };
        }
      })
    );

    const response = {
      funds: fundsWithBalances,
      total: totalFunds,
      page: pageNum,
      pages: Math.ceil(totalFunds / limitNum),
    };

    res.json(response);
    logInfo(`Returned ${fundsWithBalances.length} funds of ${totalFunds} total, page ${pageNum}/${Math.ceil(totalFunds / limitNum)}`, { response });
  })
);

router.post(
  "/:id/donate",
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { amount, donorWallet, txSignature } = req.body;

    logInfo(`POST /funds/${id}/donate - Queuing donation request`, { amount, donorWallet, txSignature });

    const donationQueue = await getDonationQueue();
    logInfo(`Queue size before adding donation: ${donationQueue.size}`);

    await donationQueue.add(async () => {
      const GAS_FEE_RESERVE = 0.05;
      const connection = getConnection();

      if (!donorWallet || !txSignature) {
        logError(`Missing required fields for fund ${id}`, { donorWallet, txSignature });
        res.status(400).json({ error: "Donor wallet address and transaction signature are required" });
        return;
      }

      if (amount < config.MIN_DONATION || amount > config.MAX_DONATION) {
        logError(`Invalid donation amount for fund ${id}`, { amount, min: config.MIN_DONATION, max: config.MAX_DONATION });
        res.status(400).json({
          error: `Donation amount must be between ${config.MIN_DONATION} and ${config.MAX_DONATION} SOL`,
        });
        return;
      }

      const fund = await Fund.findById(id);
      if (!fund || fund.status === "completed") {
        logError(`Invalid fund ${id}`, { fundExists: !!fund, status: fund?.status });
        res.status(400).json({ error: "Invalid fund" });
        return;
      }
      if (fund.initialFeePaid === 0) {
        logError(`Creation fee not paid for fund ${id}`);
        res.status(400).json({ error: "Creation fee not yet paid. Please pay the creation fee first." });
        return;
      }

      logInfo(`Verifying SOL payment for fund ${id}`);
      const paymentValid = await verifySolPayment(txSignature, donorWallet, fund.fundWalletAddress, amount);
      if (!paymentValid) {
        logError(`Transaction verification failed for fund ${id}`, {
          txSignature,
          donorWallet,
          fundWalletAddress: fund.fundWalletAddress,
          amount,
        });
        res.status(400).json({
          error: `Transaction does not contain valid SOL transfer of ${amount} SOL from ${donorWallet} to ${fund.fundWalletAddress}`,
        });
        return;
      }

      logInfo(`Confirming transaction ${txSignature} for fund ${id}`);
      await connection.confirmTransaction(txSignature, "confirmed");
      logInfo(`Transaction ${txSignature} confirmed for fund ${id}`);

      const balance = await getBalance(new PublicKey(fund.fundWalletAddress));
      const newCurrentDonatedSol = Math.max(0, balance - fund.initialFeePaid);
      logInfo(`Fund ${id} balance after donation`, { balance, currentDonatedSol: newCurrentDonatedSol });

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
      logInfo(`Updated donor ${donorWallet} for fund ${id}`, { totalDonatedSol: donor.totalDonatedSol });

      const totalTarget = fund.targetSolAmount;
      let responseSent = false;
      if (fund.currentDonatedSol >= totalTarget) {
        fund.status = "completed";
        fund.completedAt = new Date();
        logInfo(`Fund ${fund._id} reached target`, { currentDonatedSol: fund.currentDonatedSol, target: totalTarget });

        const expectedBalance = fund.initialFeePaid + fund.currentDonatedSol;
        if (balance < expectedBalance - 0.005) {
          logError(`Balance mismatch for fund ${id}`, { actual: balance, expected: expectedBalance });
          throw new Error(`Fund wallet balance (${balance} SOL) is less than expected (${expectedBalance} SOL)`);
        } else if (balance < expectedBalance) {
          logInfo(`Minor balance discrepancy for fund ${id}`, { actual: balance, expected: expectedBalance });
        }

        const fundWallet = Keypair.fromSecretKey(bs58.default.decode(fund.fundPrivateKey));
        const donatedSol = fund.currentDonatedSol;
        const buffer = donatedSol * 0.1;
        const totalSolToTransfer = donatedSol + fund.initialFeePaid - buffer - GAS_FEE_RESERVE;
        if (totalSolToTransfer <= 0) {
          logError(`Insufficient funds for token creation in fund ${id}`, { totalSolToTransfer });
          throw new Error(`Insufficient funds after reserving gas and buffer: ${totalSolToTransfer} SOL`);
        }

        await fund.save();
        logInfo(`Fund ${fund._id} saved as completed`, { status: fund.status });

        res.json({ ...fund.toJSON(), signature: txSignature });
        responseSent = true;

        setImmediate(async () => {
          try {
            const updatedFund = await Fund.findById(id);
            if (!updatedFund) {
              logError(`Fund ${id} not found during token prep`);
              return;
            }
            if (!updatedFund.image) {
              logError(`No image provided for fund ${id} during automatic token prep`);
              updatedFund.launchError = "Image is required for token creation on Pump.fun";
              await updatedFund.save();
              return;
            }
            const { apiKey, walletPublicKey, privateKey, metadataUri } = await createAndLaunchTokenWithLightning2(
              Keypair.fromSecretKey(bs58.default.decode(updatedFund.fundPrivateKey)),
              updatedFund.tokenName,
              updatedFund.tokenSymbol,
              updatedFund.targetSolAmount,
              new PublicKey(updatedFund.targetWallet),
              updatedFund.initialFeePaid,
              updatedFund.targetPercentage,
              updatedFund.image,
              totalSolToTransfer,
              updatedFund._id.toString()
            );
            updatedFund.pumpPortalApiKey = apiKey;
            updatedFund.pumpPortalWalletPublicKey = walletPublicKey;
            updatedFund.pumpPortalPrivateKey = privateKey;
            updatedFund.metadataUri = metadataUri;
            updatedFund.launchError = null;
            await updatedFund.save();
            logInfo(`Token launch prepared for fund ${id}`, { metadataUri, status: updatedFund.status });
          } catch (error: unknown) {
            logError(`Token preparation failed for fund ${id}`, error);
            const updatedFund = await Fund.findById(id);
            if (updatedFund) {
              updatedFund.launchError = error instanceof Error ? error.message : "Unknown error during token preparation";
              await updatedFund.save();
              logInfo(`Fund ${id} after error`, { status: updatedFund.status });
            }
          }
        });
      } else {
        await fund.save();
        logInfo(`Fund ${id} updated with donation`, { status: fund.status });
      }

      if (!responseSent) {
        res.json({ ...fund.toJSON(), signature: txSignature });
        logInfo(`Donation processed successfully for fund ${id}`, { status: fund.status });
      }
    });
  })
);

router.post(
  "/:id/transfer",
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { userWallet } = req.body;

    logInfo(`POST /funds/${id}/transfer - Received transfer request`, { userWallet });

    if (!userWallet) {
      logError(`Missing userWallet for fund ${id}`);
      return res.status(400).json({ error: "User wallet address is required" });
    }

    const fund = await Fund.findById(id).populate("userId", "walletAddress");
    if (!fund) {
      logError(`Fund ${id} not found`);
      return res.status(404).json({ error: "Fund not found" });
    }

    if (fund.userId.walletAddress !== userWallet) {
      logError(`Unauthorized transfer attempt for fund ${id}`, { userWallet, creator: fund.userId.walletAddress });
      return res.status(403).json({ error: "Only the fund creator can trigger this transfer" });
    }

    if (fund.status !== "completed" || !fund.tokenAddress) {
      logError(`Invalid fund state for transfer in fund ${id}`, { status: fund.status, tokenAddress: fund.tokenAddress });
      return res.status(400).json({ error: "Fund must be completed and have a token address to transfer" });
    }

    if (!fund.pumpPortalPrivateKey || !fund.pumpPortalWalletPublicKey) {
      logError(`Missing Pump.fun wallet details for fund ${id}`);
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
        logInfo(`Tokens already transferred to ${targetWallet.toBase58()}`, { amount: targetBalance.value.uiAmount });
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
        logError(`Error checking target wallet balance for fund ${id}`, err);
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
        logError(`No token account found for Pump.fun wallet: ${pumpWalletKeypair.publicKey.toBase58()}`);
        return res.status(400).json({
          error: "No tokens found in Pump.fun wallet. They may have been transferred or never deposited.",
        });
      }
      logError(`Error checking Pump.fun wallet balance for fund ${id}`, err);
      throw err;
    }

    if (!pumpBalance || (pumpBalance.value.uiAmount !== null && pumpBalance.value.uiAmount === 0)) {
      logError(`No tokens available in Pump.fun wallet for fund ${id}`);
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

    logInfo(`Manually transferred ${transferAmount / 10 ** 6} tokens to ${targetWallet.toBase58()} for fund ${id}`, { signature });
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

    logInfo(`POST /funds/${id}/launch - Received launch request`, { userWallet });

    if (!userWallet) {
      logError(`Missing userWallet for fund ${id}`);
      return res.status(400).json({ error: "User wallet address is required" });
    }

    const fund = await Fund.findById(id).populate("userId", "walletAddress");
    if (!fund) {
      logError(`Fund ${id} not found`);
      return res.status(404).json({ error: "Fund not found" });
    }

    if (fund.userId.walletAddress !== userWallet) {
      logError(`Unauthorized launch attempt for fund ${id}`, { userWallet, creator: fund.userId.walletAddress });
      return res.status(403).json({ error: "Only the fund creator can launch the token" });
    }

    if (fund.status !== "completed") {
      logError(`Fund ${id} not completed`, { status: fund.status });
      return res.status(400).json({ error: "Fund must be completed to launch the token" });
    }

    if (fund.tokenAddress) {
      logError(`Token already launched for fund ${id}`, { tokenAddress: fund.tokenAddress });
      return res.status(400).json({ error: "Token already launched" });
    }

    if (!fund.image) {
      logError(`No image provided for fund ${id} during manual launch`);
      return res.status(400).json({ error: "An image is required to launch the token on Pump.fun" });
    }

    if (typeof fund.fundPrivateKey !== "string" || !fund.fundPrivateKey) {
      logError(`Invalid fundPrivateKey for fund ${id}`, { fundPrivateKey: fund.fundPrivateKey });
      return res.status(500).json({ error: "Fund private key is missing or invalid" });
    }

    console.log("Fund private key from DB:", fund.fundPrivateKey);
    let fundWallet: Keypair;
    try {
      fundWallet = Keypair.fromSecretKey(bs58.default.decode(fund.fundPrivateKey));
      console.log("Decoded as Base58, public key:", fundWallet.publicKey.toBase58());
    } catch (base58Error) {
      logInfo(`Base58 decode failed for fund ${id}, attempting split format`, base58Error);
      try {
        if (fund.fundPrivateKey.includes(",")) {
          const privateKeyArray = fund.fundPrivateKey.split(",").map(Number);
          fundWallet = Keypair.fromSecretKey(Uint8Array.from(privateKeyArray));
          console.log("Decoded as split array, public key:", fundWallet.publicKey.toBase58());
          const base58PrivateKey = bs58.default.encode(fundWallet.secretKey);
          fund.fundPrivateKey = base58PrivateKey;
          await fund.save();
          logInfo(`Migrated fund ${id} private key to Base58 format`);
        } else {
          throw new Error("Neither Base58 nor split format worked");
        }
      } catch (splitError) {
        logError(`Failed to decode fundPrivateKey for fund ${id}`, { base58Error, splitError });
        return res.status(500).json({ error: "Invalid fund private key format" });
      }
    }

    if (fundWallet.publicKey.toBase58() !== fund.fundWalletAddress) {
      logError(`Public key mismatch for fund ${id}`, {
        expected: fund.fundWalletAddress,
        actual: fundWallet.publicKey.toBase58(),
      });
      return res.status(500).json({ error: "Fund wallet public key does not match stored address" });
    }

    const totalSolToTransfer = fund.initialFeePaid + fund.currentDonatedSol - 0.05;
    if (totalSolToTransfer <= 0) {
      logError(`Insufficient funds for token launch in fund ${id}`, { totalSolToTransfer });
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
        fund.image,
        totalSolToTransfer,
        fund._id.toString()
      );

      fund.tokenAddress = tokenAddress;
      fund.pumpPortalApiKey = apiKey;
      fund.pumpPortalWalletPublicKey = walletPublicKey;
      fund.pumpPortalPrivateKey = privateKey;
      fund.solscanUrl = solscanUrl;
      logInfo(`Token launched for fund ${id}`, { tokenAddress, solscanUrl });
      fund.launchError = null;
      await fund.save();

      res.json({
        message: `Token launched successfully`,
        tokenAddress,
        signature: solscanUrl,
      });
    } catch (error: unknown) {
      logError(`Manual token creation failed for fund ${id}`, error);
      fund.launchError = error instanceof Error ? error.message : "Unknown error during manual token creation";
      await fund.save();
      return res.status(500).json({ error: fund.launchError });
    }
  })
);

router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    logInfo(`GET /funds/${id} - Fetching fund details`, { id });

    const fund = await Fund.findById(id).populate("userId", "walletAddress");
    if (!fund) {
      logError(`Fund ${id} not found`);
      return res.status(404).json({ error: `Fund with ID ${id} not found` });
    }

    let currentBalance: number | null = null;
    try {
      currentBalance = await getBalance(new PublicKey(fund.fundWalletAddress));
    } catch (error) {
      logError(`Failed to fetch balance for fund ${id}`, error);
    }

    const fundData = {
      ...fund.toJSON(),
      currentBalance,
    };

    res.json(fundData);
    logInfo(`Returned fund details for ${id}`, { fundId: id, status: fund.status });
  })
);

export default router;