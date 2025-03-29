import express from "express";
import mongoose from "mongoose";
import User from "../models/User";
import Fund from "../models/Fund";
import { generateWallet, getBalance, transferSol } from "../utils/solana";
import { createAndLaunchToken } from "../utils/pumpfun";
import { PublicKey, Keypair } from "@solana/web3.js";
import { asyncHandler } from "../utils/asyncHandler";

const router = express.Router();

const targetSolMap: { [key: number]: number } = {
  5: 1.480938417,
  10: 3.114080165,
  25: 9.204131229,
  50: 26.439790577,
  75: 70.356037153,
};

// Create a new fund (user pays 0.1 SOL to campaign wallet)
router.post("/", asyncHandler(async (req, res) => {
  const { userWallet, name, image, tokenName, tokenSymbol, targetPercentage, targetWallet } = req.body;

  // Validate user wallet (should have sent 0.1 SOL, checked client-side for now)
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
    fundPrivateKey: fundWallet.secretKey.toString(), // Encrypt in production
    tokenName,
    tokenSymbol,
    targetPercentage,
    targetSolAmount: targetSolMap[targetPercentage],
    targetWallet,
  });

  await fund.save();

  // Return fund details; client must send 0.1 SOL to fundWalletAddress
  res.status(201).json({
    ...fund.toJSON(),
    message: `Please send 0.1 SOL to ${fundWallet.publicKey.toBase58()} to activate the campaign`,
  });
}));

// Get all funds
router.get("/", asyncHandler(async (req, res) => {
  const funds = await Fund.find().populate("userId", "walletAddress");
  for (const fund of funds) {
    fund.currentDonatedSol = await getBalance(new PublicKey(fund.fundWalletAddress));
    await fund.save();
  }
  res.json(funds);
}));

// Donate to a fund
router.post("/:id/donate", asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { amount } = req.body as { amount: number };

  const fund = await Fund.findById(id);
  if (!fund || fund.status === "completed") return res.status(400).json({ error: "Invalid fund" });

  const balance = await getBalance(new PublicKey(fund.fundWalletAddress));
  fund.currentDonatedSol = balance;

  const totalTarget = fund.targetSolAmount + 0.1; // Target + initial 0.1 SOL fee
  if (balance >= totalTarget) {
    const fundWallet = Keypair.fromSecretKey(Buffer.from(fund.fundPrivateKey.split(","), "utf8"));

    // Calculate excess (above target + fee)
    const excessSol = balance - totalTarget;
    if (excessSol > 0) {
      const websiteWallet = new PublicKey(process.env.WEBSITE_WALLET!);
      await transferSol(fundWallet, websiteWallet, excessSol);
      console.log(`Transferred ${excessSol} SOL excess to WEBSITE_WALLET`);
    }

    // Launch token with 0.1 SOL fee + target amount
    const tokenAddress = await createAndLaunchToken(
      fundWallet,
      fund.tokenName,
      fund.tokenSymbol,
      fund.targetSolAmount, // Funds for token creation
      new PublicKey(fund.targetWallet)
    );
    fund.tokenAddress = tokenAddress;
    fund.status = "completed";
    await fund.save();
  }

  await fund.save();
  res.json(fund);
}));

export default router;