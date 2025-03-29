import express from "express";
import mongoose from "mongoose";
import User from "../models/User";
import Fund from "../models/Fund";
import { generateWallet, getBalance, transferSol } from "../utils/solana";
import { createAndLaunchToken } from "../utils/pumpfun";
import { PublicKey, Keypair } from "@solana/web3.js";
import { asyncHandler } from "../utils/asyncHandler";

const router = express.Router();

const CROWD_FUND_CREATION_FEE = parseFloat(process.env.CROWD_FUND_CREATION_FEE || "0.1");

const targetSolMap: { [key: number]: number } = {
  5: 1.480938417,
  10: 3.114080165,
  25: 9.204131229,
  50: 26.439790577,
  75: 70.356037153,
};

router.get("/fee", asyncHandler(async (req, res) => {
  res.json({ fee: CROWD_FUND_CREATION_FEE });
}));

router.post("/", asyncHandler(async (req, res) => {
  const { userWallet, name, image, tokenName, tokenSymbol, tokenDescription, targetPercentage, targetWallet, tokenTwitter, tokenTelegram, tokenWebsite } = req.body;

  if (!userWallet || !name || !tokenName || !tokenSymbol || !tokenDescription || !targetPercentage || !targetWallet) {
    return res.status(400).json({ error: "Required fields are missing" });
  }

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
    targetPercentage,
    targetSolAmount: targetSolMap[targetPercentage],
    targetWallet,
    tokenTwitter,
    tokenTelegram,
    tokenWebsite,
    launchFee: CROWD_FUND_CREATION_FEE,
    initialFeePaid: 0,
  });

  await fund.save();

  res.status(201).json({
    ...fund.toJSON(),
    message: `Please send ${CROWD_FUND_CREATION_FEE} SOL to ${fundWallet.publicKey.toBase58()} to activate the campaign`,
  });
}));

router.get("/", asyncHandler(async (req, res) => {
  const { status } = req.query;

  if (status && !["active", "completed"].includes(status as string)) {
    return res.status(400).json({ error: "Invalid status parameter. Must be 'active' or 'completed'." });
  }

  const query = status ? { status } : {};
  const funds = await Fund.find(query).populate("userId", "walletAddress");

  // No longer update currentDonatedSol here; just fetch the existing value
  for (const fund of funds) {
    console.log(`GET /funds - Fund ${fund._id}: currentDonatedSol=${fund.currentDonatedSol}, initialFeePaid=${fund.initialFeePaid}`);
  }

  res.json(funds);
}));

router.post("/:id/donate", asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { amount, donorWallet } = req.body as { amount: number; donorWallet: string };

  if (!donorWallet) {
    return res.status(400).json({ error: "Donor wallet address is required" });
  }

  const fund = await Fund.findById(id);
  if (!fund || fund.status === "completed") return res.status(400).json({ error: "Invalid fund" });

  const balance = await getBalance(new PublicKey(fund.fundWalletAddress));
  if (fund.initialFeePaid === 0) {
    fund.initialFeePaid = fund.launchFee;
    console.log(`POST /funds/${id}/donate - Fund ${id}: Set initialFeePaid=${fund.initialFeePaid}`);
  }

  // Update currentDonatedSol based on the balance, excluding initialFeePaid
  const previousDonatedSol = fund.currentDonatedSol || 0;
  fund.currentDonatedSol = Math.max(0, balance - fund.initialFeePaid);
  console.log(`POST /funds/${id}/donate - Fund ${id}: balance=${balance}, initialFeePaid=${fund.initialFeePaid}, currentDonatedSol=${fund.currentDonatedSol}`);

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
    const fundWallet = Keypair.fromSecretKey(Buffer.from(fund.fundPrivateKey.split(","), "utf8"));

    const excessSol = fund.currentDonatedSol - totalTarget;
    if (excessSol > 0) {
      const websiteWallet = new PublicKey(process.env.WEBSITE_WALLET!);
      await transferSol(fundWallet, websiteWallet, excessSol);
      console.log(`Transferred ${excessSol} SOL excess to WEBSITE_WALLET`);
    }

    const tokenAddress = await createAndLaunchToken(
      fundWallet,
      fund.tokenName,
      fund.tokenSymbol,
      fund.targetSolAmount,
      new PublicKey(fund.targetWallet)
    );
    fund.tokenAddress = tokenAddress;
    fund.status = "completed";
    fund.completedAt = new Date();
    await fund.save();
  }

  await fund.save();
  res.json(fund);
}));

router.get("/users/leaderboard", asyncHandler(async (req, res) => {
  const users = await User.find()
    .sort({ totalDonatedSol: -1 })
    .limit(10)
    .populate("donations.fundId", "name tokenSymbol");

  res.json(users);
}));

export default router;