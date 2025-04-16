import express from "express";
import User from "../models/User";
import Fund from "../models/Fund";
import mongoose from "mongoose";
import { generateWallet, getBalance, transferSol, verifySolPayment, getConnection, confirmTransaction } from "../utils/solana";
import { createAndLaunchTokenWithLightning } from "../utils/pumpfun";
import { PublicKey, Keypair, Transaction, SystemProgram, LAMPORTS_PER_SOL, Connection, TransactionMessage } from "@solana/web3.js";
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
  5: 1.480938417,
  10: 3.114080165,
  25: 9.204131229,
  50: 26.439790577,
  75: 70.356037153,
};

const validTargetPercentages = [5, 10, 25, 50, 75] as const;
type TargetPercentage = typeof validTargetPercentages[number];

const config = getConfig();
const websiteWallet = config.WEBSITE_WALLET_KEYPAIR.publicKey;
const websiteWalletKeypair = config.WEBSITE_WALLET_KEYPAIR;

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

// URL validation utility
const isValidUrl = (url: string): boolean => /^(https?:\/\/[^\s$.?#].[^\s]*)$/i.test(url);

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
    console.log("Raw request body:", req.body);
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

    if (tokenTwitter && !isValidUrl(tokenTwitter)) {
      logError(`Invalid tokenTwitter URL: ${tokenTwitter}`);
      return res.status(400).json({ error: "Invalid Twitter URL" });
    }
    if (tokenTelegram && !isValidUrl(tokenTelegram)) {
      logError(`Invalid tokenTelegram URL: ${tokenTelegram}`);
      return res.status(400).json({ error: "Invalid Telegram URL" });
    }
    if (tokenWebsite && !isValidUrl(tokenWebsite)) {
      logError(`Invalid tokenWebsite URL: ${tokenWebsite}`);
      return res.status(400).json({ error: "Invalid Website URL" });
    }

    const parsedTargetPercentage = Number(targetPercentage);
    if (!validTargetPercentages.includes(parsedTargetPercentage as TargetPercentage)) {
      logError(`Invalid targetPercentage: ${parsedTargetPercentage}`);
      return res.status(400).json({ error: "Invalid targetPercentage. Must be one of: 5, 10, 25, 50, 75" });
    }
    const typedTargetPercentage = parsedTargetPercentage as TargetPercentage;

    let user = await User.findOne({ walletAddress: userWallet });
    if (!user) {
      user = new User({ walletAddress: userWallet });
      await user.save();
      logInfo(`Created new user: ${userWallet}`);
    }

    const fundWallet = generateWallet();
    const connection = getConnection();

    // Verify and confirm payment first
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

    const { lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    try {
      await confirmTransaction(txSignature, lastValidBlockHeight);
    } catch (error) {
      logError(`Failed to confirm user payment transaction ${txSignature}`, error);
      return res.status(400).json({
        error: `Failed to confirm payment transaction ${txSignature}. Check Solana Explorer for status.`,
      });
    }

    const fund = new Fund({
      userId: user._id,
      name,
      image,
      fundWalletAddress: fundWallet.publicKey.toBase58(),
      fundPrivateKey: bs58.default.encode(fundWallet.secretKey),
      tokenName,
      tokenSymbol,
      tokenDescription,
      targetPercentage: typedTargetPercentage,
      targetSolAmount: targetSolMap[typedTargetPercentage],
      targetWallet,
      tokenTwitter: tokenTwitter || "",
      tokenTelegram: tokenTelegram || "",
      tokenWebsite: tokenWebsite || "",
      launchFee: config.CROWD_FUND_CREATION_FEE,
      initialFeePaid: 0,
      launchStatus: null,
    });

    const gasReserve = await calculateGasFeeReserve(connection);

    try {
      // Save fund before transferring SOL
      await fund.save();
      logInfo(`Fund saved: ${fund._id}`);

      // Transfer SOL from website wallet to fund wallet
      const websiteBalance = await getBalance(websiteWalletKeypair.publicKey);
      const transferAmount = config.CROWD_FUND_CREATION_FEE * 0.99; // 99% to fund wallet      
      if (websiteBalance < transferAmount + gasReserve) {
        throw new Error(`Insufficient balance in WEBSITE_WALLET: ${websiteBalance} SOL, need ${transferAmount + gasReserve} SOL`);
      }

      const transferSignature = await transferSol(websiteWalletKeypair, fundWallet.publicKey, transferAmount, true);
      logInfo(`Transferred ${transferAmount} SOL from ${websiteWallet.toBase58()} to ${fund.fundWalletAddress}`, { tx: transferSignature });

      // Update fund with transferred amount
      fund.initialFeePaid = transferAmount;
      await fund.save();

      res.status(201).json({
        ...fund.toJSON(),
        message: `Fund created and ${transferAmount} SOL transferred to fund wallet. Transaction signature: ${transferSignature}`,
      });
      logInfo(`Fund creation completed: ${fund._id}`);
    } catch (error: unknown) {
      // Refund logic if SOL was deducted but creation failed
      const refundAmount = config.CROWD_FUND_CREATION_FEE;
      let refundSignature: string | undefined;

      try {
        const websiteBalance = await getBalance(websiteWalletKeypair.publicKey);
        if (websiteBalance >= refundAmount + gasReserve) {
          refundSignature = await transferSol(websiteWalletKeypair, new PublicKey(userWallet), refundAmount, true);
          logInfo(`Refunded ${refundAmount} SOL to ${userWallet}`, { tx: refundSignature });
        } else {
          logError(`Insufficient balance for refund: ${websiteBalance} SOL, need ${refundAmount + gasReserve} SOL`);
        }
      } catch (refundError) {
        logError(`Failed to refund ${refundAmount} SOL to ${userWallet}`, refundError);
      }

      // Cleanup
      if (mongoose.Types.ObjectId.isValid(fund._id)) {
        await Fund.findByIdAndDelete(fund._id);
        logInfo(`Deleted fund ${fund._id} due to creation failure`);
      }

      logError(`Fund creation failed`, error);
      const errorMsg = error instanceof Error ? error.message : "Internal server error during fund creation";
      return res.status(500).json({
        error: errorMsg,
        refundSignature: refundSignature || "Refund failed or not attempted",
      });
    }
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

    const totalInDb = await Fund.countDocuments(query);
    logInfo(`Total funds in DB matching query`, { total: totalInDb });

    const funds = await Fund.find(query)
      .sort(status === "completed" ? { completedAt: -1 } : { createdAt: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .populate("userId", "walletAddress");

    logInfo(`Fetched funds from DB`, { count: funds.length, page: pageNum, limit: limitNum });

    const totalFunds = await Fund.countDocuments(query);
    logInfo(`Found ${funds.length} funds of ${totalFunds} total for status=${status}, page=${pageNum}`);

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

    let fund: InstanceType<typeof Fund> | null = null;
    let responseData: any = null;
    let errorMessage: string | null = null;

    // Add the task to the queue and handle it as void
    await donationQueue.add(async (): Promise<void> => {
      const connection = getConnection();
      const GAS_FEE_RESERVE = await calculateGasFeeReserve(connection);

      if (!donorWallet || !txSignature) {
        logError(`Missing required fields for fund ${id}`, { donorWallet, txSignature });
        errorMessage = "Donor wallet address and transaction signature are required";
        return;
      }

      if (amount < config.MIN_DONATION || amount > config.MAX_DONATION) {
        logError(`Invalid donation amount for fund ${id}`, { amount, min: config.MIN_DONATION, max: config.MAX_DONATION });
        errorMessage = `Donation amount must be between ${config.MIN_DONATION} and ${config.MAX_DONATION} SOL`;
        return;
      }

      fund = await Fund.findById(id);
      if (!fund) {
        logError(`Fund ${id} not found`);
        errorMessage = "Invalid fund";
        return;
      }

      // Check if the crowdfund is already completed
      if (fund.status === "completed") {
        logInfo(`Donation rejected for fund ${id} - Crowdfund already completed`, {
          donorWallet,
          amount,
          txSignature,
        });
        errorMessage = "Crowdfund is already completed. No further donations are accepted.";
        return;
      }

      if (fund.initialFeePaid === 0) {
        logError(`Creation fee not paid for fund ${id}`);
        errorMessage = "Creation fee not yet paid. Please pay the creation fee first.";
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
        errorMessage = `Transaction does not contain valid SOL transfer of ${amount} SOL from ${donorWallet} to ${fund.fundWalletAddress}`;
        return;
      }

      logInfo(`Confirming transaction ${txSignature} for fund ${id}`);
      await connection.confirmTransaction(txSignature, "confirmed");
      logInfo(`Transaction ${txSignature} confirmed for fund ${id}`);

      const balance = await getBalance(new PublicKey(fund.fundWalletAddress));
      const newCurrentDonatedSol = Math.max(0, balance - fund.initialFeePaid);
      fund.currentDonatedSol = newCurrentDonatedSol;

      const donor = await User.findOneAndUpdate(
        { walletAddress: donorWallet },
        {
          $push: { donations: { fundId: fund._id, amount, donatedAt: new Date() } },
          $inc: { totalDonatedSol: amount },
        },
        { upsert: true, new: true }
      );
      logInfo(`Updated donor ${donorWallet} for fund ${id}`, { totalDonatedSol: donor.totalDonatedSol });

      const totalTarget = fund.targetSolAmount;
      if (fund.currentDonatedSol >= totalTarget) {
        fund.status = "completed";
        fund.completedAt = new Date();
        fund.launchStatus = "pending";

        const expectedBalance = fund.initialFeePaid + fund.currentDonatedSol;
        if (balance < expectedBalance - GAS_FEE_RESERVE) {
          logError(`Balance mismatch for fund ${id}`, { actual: balance, expected: expectedBalance });
          errorMessage = `Fund wallet balance (${balance} SOL) is less than expected (${expectedBalance} SOL)`;
          return;
        }

        const donatedSol = fund.currentDonatedSol;
        const feeRaiseWallet = fund.initialFeePaid * 0.3;
        const newInitialFeePaid = fund.initialFeePaid - feeRaiseWallet;
        const buffer = donatedSol * 0.01;
        const solForCreation = donatedSol - buffer;
        const totalSolToTransfer = solForCreation + newInitialFeePaid;

        if (totalSolToTransfer <= 0) {
          logError(`Insufficient funds for token creation in fund ${id}`, { totalSolToTransfer });
          errorMessage = `Insufficient funds after reserving gas and buffer: ${totalSolToTransfer} SOL`;
          return;
        }

        await fund.save();
        logInfo(`Fund ${fund._id} saved as completed`, { status: fund.status });
        logInfo(`Fund ${fund._id} donatedSol`, { donatedSol: donatedSol });
        logInfo(`Fund ${fund._id} feeRaiseWallet`, { feeRaiseWallet: feeRaiseWallet });
        logInfo(`Fund ${fund._id} newInitialFeePaid`, { newInitialFeePaid: newInitialFeePaid });
        logInfo(`Fund ${fund._id} buffer`, { buffer: buffer });
        logInfo(`Fund ${fund._id} solForCreation`, { solForCreation: solForCreation });
        logInfo(`Fund ${fund._id} totalSolToTransfer`, { totalSolToTransfer: totalSolToTransfer });

        responseData = { ...fund.toJSON(), signature: txSignature };

        // Launch token creation in the background
        setImmediate(async () => {
          try {
            const updatedFund = await Fund.findById(id);
            if (!updatedFund) {
              logError(`Fund ${id} not found during token launch`);
              return;
            }
            if (!updatedFund.image) {
              logError(`No image provided for fund ${id} during automatic token launch`);
              updatedFund.launchError = "Image is required for token creation on Pump.fun";
              updatedFund.launchStatus = "failed";
              await updatedFund.save();
              return;
            }

            const { tokenAddress, apiKey, walletPublicKey, privateKey, solscanUrl, metadataUri } = await createAndLaunchTokenWithLightning(
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

            updatedFund.tokenAddress = tokenAddress;
            updatedFund.pumpPortalApiKey = apiKey;
            updatedFund.pumpPortalWalletPublicKey = walletPublicKey;
            updatedFund.pumpPortalPrivateKey = privateKey;
            updatedFund.solscanUrl = solscanUrl;
            updatedFund.metadataUri = metadataUri;
            updatedFund.launchError = null;
            updatedFund.launchStatus = "completed";
            await updatedFund.save();
            logInfo(`Token launched for fund ${id}`, { tokenAddress, solscanUrl });
          } catch (error: unknown) {
            logError(`Token launch failed for fund ${id}`, error);
            const updatedFund = await Fund.findById(id);
            if (updatedFund) {
              updatedFund.launchError = error instanceof Error ? error.message : "Unknown error during token launch";
              updatedFund.launchStatus = "failed";
              await updatedFund.save();
              logInfo(`Fund ${id} after error`, { status: updatedFund.status });
            }
          }
        });
      } else {
        await fund.save();
        logInfo(`Fund ${id} updated with donation`, { status: fund.status });
        responseData = { ...fund.toJSON(), signature: txSignature };
      }
    });

    // Handle the response outside the queue
    if (errorMessage) {
      return res.status(400).json({ error: errorMessage });
    }
    if (responseData) {
      logInfo(`Donation processed successfully for fund ${id}`, { status: fund?.status });
      return res.json(responseData);
    }

    // If we reach here, something unexpected happened
    throw new Error("Donation processing completed without setting response or error");
  })
);

router.post(
  "/:id/pre-donate",
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { amount, donorWallet } = req.body;

    logInfo(`POST /funds/${id}/pre-donate - Validating donation`, { amount, donorWallet });

    if (!donorWallet || !amount) {
      logError(`Missing required fields for fund ${id}`, { donorWallet, amount });
      return res.status(400).json({ error: "Donor wallet address and amount are required" });
    }

    if (amount < config.MIN_DONATION || amount > config.MAX_DONATION) {
      logError(`Invalid donation amount for fund ${id}`, { amount, min: config.MIN_DONATION, max: config.MAX_DONATION });
      return res.status(400).json({ error: `Donation amount must be between ${config.MIN_DONATION} and ${config.MAX_DONATION} SOL` });
    }

    const fund = await Fund.findById(id);
    if (!fund) {
      logError(`Fund ${id} not found`);
      return res.status(404).json({ error: "Fund not found" });
    }

    if (fund.status === "completed") {
      logInfo(`Pre-donation rejected for fund ${id} - Crowdfund already completed`);
      return res.status(400).json({ error: "Crowdfund is already completed. No further donations are accepted." });
    }

    if (fund.initialFeePaid === 0) {
      logError(`Creation fee not paid for fund ${id}`);
      return res.status(400).json({ error: "Creation fee not yet paid. Please pay the creation fee first." });
    }

    res.status(200).json({
      message: "Donation allowed",
      fundWalletAddress: fund.fundWalletAddress,
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

    const pumpWalletBalance = await getBalance(pumpWalletKeypair.publicKey);
    const GAS_FEE_RESERVE = await calculateGasFeeReserve(connection);
    if (pumpWalletBalance < GAS_FEE_RESERVE) {
      logError(`Insufficient SOL for gas in pump wallet for fund ${id}`, { balance: pumpWalletBalance, required: GAS_FEE_RESERVE });
      return res.status(400).json({ error: `Insufficient SOL for gas fees in pump wallet: ${pumpWalletBalance} SOL, need ${GAS_FEE_RESERVE} SOL` });
    }

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

    let fundWallet: Keypair;
    try {
      fundWallet = Keypair.fromSecretKey(bs58.default.decode(fund.fundPrivateKey));
    } catch (error) {
      logError(`Failed to decode fundPrivateKey for fund ${id}`, error);
      return res.status(500).json({ error: "Invalid fund private key format" });
    }

    if (fundWallet.publicKey.toBase58() !== fund.fundWalletAddress) {
      logError(`Public key mismatch for fund ${id}`, {
        expected: fund.fundWalletAddress,
        actual: fundWallet.publicKey.toBase58(),
      });
      return res.status(500).json({ error: "Fund wallet public key does not match stored address" });
    }

    const donatedSol = fund.currentDonatedSol;
    const feeRaiseWallet = fund.initialFeePaid * 0.3;
    const newInitialFeePaid = fund.initialFeePaid - feeRaiseWallet;
    const solForCreation = donatedSol; // Amount for token creation
    const totalSolToTransfer = solForCreation + newInitialFeePaid;

    // Set launchStatus to "pending" and save immediately
    fund.launchStatus = "pending";
    await fund.save();
    logInfo(`Fund ${id} marked as pending launch`);

    // Return early with a "pending" response
    res.status(202).json({
      message: "Token launch request accepted and processing in the background",
      status: "pending",
    });

    // Process the token launch in the background
    setImmediate(async () => {
      try {
        const updatedFund = await Fund.findById(id);
        if (!updatedFund) {
          logError(`Fund ${id} not found during background token launch`);
          return;
        }

        const { tokenAddress, apiKey, walletPublicKey, privateKey, solscanUrl, metadataUri } = await createAndLaunchTokenWithLightning(
          fundWallet,
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

        updatedFund.tokenAddress = tokenAddress;
        updatedFund.pumpPortalApiKey = apiKey;
        updatedFund.pumpPortalWalletPublicKey = walletPublicKey;
        updatedFund.pumpPortalPrivateKey = privateKey;
        updatedFund.solscanUrl = solscanUrl;
        updatedFund.metadataUri = metadataUri;
        updatedFund.launchError = null;
        updatedFund.launchStatus = "completed";
        await updatedFund.save();

        logInfo(`Token launched successfully for fund ${id}`, { tokenAddress, solscanUrl });
      } catch (error: unknown) {
        logError(`Background token launch failed for fund ${id}`, error);
        const updatedFund = await Fund.findById(id);
        if (updatedFund) {
          updatedFund.launchError = error instanceof Error ? error.message : "Unknown error during token launch";
          updatedFund.launchStatus = "failed";
          await updatedFund.save();
          logInfo(`Fund ${id} updated with launch failure`, { status: updatedFund.status });
        }
      }
    });
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

router.get(
  "/:id/status",
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    logInfo(`GET /funds/${id}/status - Checking fund status`, { id });

    if (!mongoose.Types.ObjectId.isValid(id)) {
      logError(`Invalid fund ID: ${id}`);
      return res.status(400).json({ error: "Invalid fund ID" });
    }

    const fund = await Fund.findById(id);
    if (!fund) {
      logError(`Fund ${id} not found`);
      return res.status(404).json({ error: `Fund with ID ${id} not found` });
    }

    const isCompleted = fund.status === "completed";
    logInfo(`Fund ${id} status checked`, { status: fund.status, isCompleted });

    res.json({ isCompleted });
  })
);

export default router;