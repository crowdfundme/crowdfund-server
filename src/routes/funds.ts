import express from "express";
import User from "../models/User";
import Fund from "../models/Fund";
import { generateWallet, getBalance, transferSol, verifySolPayment, getConnection } from "../utils/solana";
import { createAndLaunchToken, createAndLaunchTokenWithApi, createAndLaunchTokenWithLightning } from "../utils/pumpfun";
import { PublicKey, Keypair } from "@solana/web3.js";
import { asyncHandler } from "../utils/asyncHandler";
import { getConfig } from "../config";
import { getOrCreateAssociatedTokenAccount, transfer, getAssociatedTokenAddress } from "@solana/spl-token";
import bs58 from "bs58";

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

router.get(
  "/fee",
  asyncHandler(async (req, res) => {
    const config = getConfig();

    console.log(`GET /funds/fee - Request from ${req.ip} at ${new Date().toISOString()} - Returning fee values:`, {
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
    } = req.body;

    const config = getConfig();

    if (
      !userWallet ||
      !name ||
      !tokenName ||
      !tokenSymbol ||
      !tokenDescription ||
      !targetPercentage ||
      !targetWallet
    ) {
      return res.status(400).json({ error: "Required fields are missing" });
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
    const fund = new Fund({
      userId: user._id,
      name,
      image,
      fundWalletAddress: fundWallet.publicKey.toBase58(),
      fundPrivateKey: fundWallet.secretKey.toString(),
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

    res.status(201).json({
      ...fund.toJSON(),
      message: `Fund created. Please send ${config.CROWD_FUND_CREATION_FEE} SOL to ${fund.fundWalletAddress} to activate.`,
    });
  })
);

router.put(
  "/:id",
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { txSignature } = req.body;
    const config = getConfig();

    if (!txSignature) {
      return res.status(400).json({ error: "Transaction signature is required" });
    }

    const fund = await Fund.findById(id).populate("userId", "walletAddress");
    if (!fund) {
      return res.status(404).json({ error: "Fund not found" });
    }

    if (fund.initialFeePaid > 0) {
      return res.status(400).json({ error: "Creation fee already paid" });
    }

    const paymentValid = await verifySolPayment(
      txSignature,
      fund.userId.walletAddress,
      fund.fundWalletAddress,
      config.CROWD_FUND_CREATION_FEE
    );
    if (!paymentValid) {
      return res.status(400).json({
        error: `Transaction does not contain valid SOL transfer of ${config.CROWD_FUND_CREATION_FEE} SOL to ${fund.fundWalletAddress}`,
      });
    }

    fund.initialFeePaid = config.CROWD_FUND_CREATION_FEE;
    await fund.save();

    res.status(200).json({
      ...fund.toJSON(),
      message: `Creation fee paid successfully. Transaction signature: ${txSignature}`,
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
      console.log(
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

    const config = getConfig();
    const GAS_FEE_RESERVE = 0.001;
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

    // Verify and confirm the donation transaction
    const paymentValid = await verifySolPayment(txSignature, donorWallet, fund.fundWalletAddress, amount);
    if (!paymentValid) {
      return res.status(400).json({
        error: `Transaction does not contain valid SOL transfer of ${amount} SOL from ${donorWallet} to ${fund.fundWalletAddress}`,
      });
    }

    // Wait for transaction to be finalized
    await connection.confirmTransaction(txSignature, "finalized");
    console.log(`Donation transaction ${txSignature} confirmed for fund ${id}`);

    // Fetch the updated balance once after confirmation
    const balance = await getBalance(new PublicKey(fund.fundWalletAddress), "finalized");
    const newCurrentDonatedSol = Math.max(0, balance - fund.initialFeePaid);
    console.log(`Fund ${id} balance after donation: ${balance} SOL, currentDonatedSol updated to ${newCurrentDonatedSol} SOL`);

    // Update fund with the latest donation
    fund.currentDonatedSol = newCurrentDonatedSol;

    // Update donor info
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
      // Mark as completed
      fund.status = "completed";
      fund.completedAt = new Date();
      console.log(`Fund ${fund._id} reached target: ${fund.currentDonatedSol} SOL >= ${totalTarget} SOL`);

      // Validate balance against expected amount
      const expectedBalance = fund.initialFeePaid + fund.currentDonatedSol;
      if (balance < expectedBalance - 0.001) { // Allow small tolerance for network fees
        console.error(`Balance mismatch for fund ${id}: actual=${balance} SOL, expected=${expectedBalance} SOL`);
        throw new Error(`Fund wallet balance (${balance} SOL) is less than expected (${expectedBalance} SOL)`);
      }

      const fundWallet = Keypair.fromSecretKey(Buffer.from(fund.fundPrivateKey.split(","), "utf8"));
      const totalSolToTransfer = fund.initialFeePaid + fund.currentDonatedSol - GAS_FEE_RESERVE;
      if (totalSolToTransfer <= 0) {
        throw new Error(`Insufficient funds after reserving gas: ${totalSolToTransfer} SOL`);
      }

      // Save fund state before token creation
      await fund.save();
      console.log(`Fund ${fund._id} saved as completed before token creation`);

      try {
        const { tokenAddress, apiKey, walletPublicKey, privateKey } = await createAndLaunchTokenWithLightning(
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
        console.log(`Token creation and transfer succeeded for fund ${fund._id}`);
      } catch (error: unknown) {
        console.error(`Token creation or transfer failed for fund ${fund._id}:`, error);
        fund.launchError = error instanceof Error ? error.message : "Unknown error during token creation/transfer";
      }

      // Final save with token details or error
      await fund.save();
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
    const pumpWalletKeypair = Keypair.fromSecretKey(bs58.decode(fund.pumpPortalPrivateKey));
    const tokenMint = new PublicKey(fund.tokenAddress);
    const targetWallet = new PublicKey(fund.targetWallet);

    const pumpTokenAccountAddress = await getAssociatedTokenAddress(tokenMint, pumpWalletKeypair.publicKey);
    const targetTokenAccountAddress = await getAssociatedTokenAddress(tokenMint, targetWallet);

    console.log(`Checking target wallet ATA: ${targetTokenAccountAddress.toBase58()}`);
    let targetBalance;
    try {
      targetBalance = await connection.getTokenAccountBalance(targetTokenAccountAddress, "confirmed");
      if (targetBalance.value.uiAmount !== null && targetBalance.value.uiAmount > 0) {
        console.log(`Tokens already transferred to ${targetWallet.toBase58()}: ${targetBalance.value.uiAmount} tokens`);
        fund.launchError = null;
        await fund.save();
        return res.json({
          message: `Tokens already transferred to ${targetWallet.toBase58()}. Amount: ${targetBalance.value.uiAmount} tokens`,
        });
      }
    } catch (err: unknown) {
      if (err instanceof Error && (err.name === "TokenAccountNotFoundError" || (err.message.includes("could not find account")))) {
        console.log(`No token account found for target wallet: ${targetWallet.toBase58()}`);
      } else {
        console.error(`Error checking target wallet balance:`, err);
        throw err;
      }
    }

    console.log(`Checking Pump.fun wallet ATA: ${pumpTokenAccountAddress.toBase58()}`);
    let pumpBalance;
    try {
      pumpBalance = await connection.getTokenAccountBalance(pumpTokenAccountAddress, "confirmed");
    } catch (err: unknown) {
      if (err instanceof Error && (err.name === "TokenAccountNotFoundError" || err.message.includes("could not find account"))) {
        console.log(`No token account found for Pump.fun wallet: ${pumpWalletKeypair.publicKey.toBase58()}`);
        return res.status(400).json({
          error: "No tokens found in Pump.fun wallet. They may have been transferred or never deposited.",
        });
      }
      console.error(`Error checking Pump.fun wallet balance:`, err);
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

    console.log(`Manually transferred ${transferAmount / 10 ** 6} tokens to ${targetWallet.toBase58()} for fund ${id}`);
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

    const fundWallet = Keypair.fromSecretKey(Buffer.from(fund.fundPrivateKey.split(","), "utf8"));
    const totalSolToTransfer = fund.initialFeePaid + fund.currentDonatedSol - 0.001; // GAS_FEE_RESERVE

    if (totalSolToTransfer <= 0) {
      return res.status(400).json({ error: `Insufficient funds after reserving gas: ${totalSolToTransfer} SOL` });
    }

    try {
      const { tokenAddress, apiKey, walletPublicKey, privateKey } = await createAndLaunchTokenWithLightning(
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
      fund.launchError = null;
      await fund.save();

      res.json({
        message: `Token launched successfully`,
        tokenAddress,
        signature: `https://solscan.io/tx/${tokenAddress}?cluster=devnet`, // Update with actual signature if available
      });
    } catch (error: unknown) {
      console.error(`Manual token creation failed for fund ${id}:`, error);
      fund.launchError = error instanceof Error ? error.message : "Unknown error during manual token creation";
      await fund.save();
      return res.status(500).json({ error: fund.launchError });
    }
  })
);

export default router;