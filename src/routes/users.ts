import express from "express";
import User from "../models/User";
import Fund from "../models/Fund";
import { asyncHandler } from "../utils/asyncHandler";

// Define interfaces for TypeScript
interface Donation {
  fundId: {
    _id: string;
    name: string;
    tokenSymbol: string;
  };
  amount: number;
  donatedAt: Date;
}

interface UserWithDonations {
  walletAddress: string;
  name?: string;
  email?: string;
  totalDonatedSol: number;
  donations: Donation[];
}

interface TotalDonatedUser {
  walletAddress: string;
  totalDonatedSol: number;
}

const router = express.Router();

// Register or fetch user by wallet address
router.post(
  "/register",
  asyncHandler(async (req, res) => {
    const { walletAddress } = req.body;
    if (!walletAddress) return res.status(400).json({ error: "Wallet address required" });

    let user = await User.findOne({ walletAddress });
    if (!user) {
      user = new User({ walletAddress });
      await user.save();
    }

    res.status(200).json({ userId: user._id, walletAddress: user.walletAddress });
  })
);

// Leaderboard of total SOL donated (no history) - Top 100
router.get(
  "/leaderboard/total",
  asyncHandler(async (req, res) => {
    const users = await User.find()
      .sort({ totalDonatedSol: -1 })
      .limit(100) // Changed from 10 to 100
      .select("walletAddress totalDonatedSol");

    const leaderboard: TotalDonatedUser[] = users.map((user) => ({
      walletAddress: user.walletAddress,
      totalDonatedSol: user.totalDonatedSol,
    }));

    res.status(200).json(leaderboard);
  })
);

// Leaderboard of top donors per fund - Top 100
router.get(
  "/leaderboard/fund/:fundId",
  asyncHandler(async (req, res) => {
    const { fundId } = req.params;

    const fund = await Fund.findById(fundId);
    if (!fund) {
      return res.status(404).json({ error: "Fund not found" });
    }

    const users = await User.find({ "donations.fundId": fundId })
      .sort({ "donations.amount": -1 })
      .limit(100) // Changed from 10 to 100
      .populate({
        path: "donations.fundId",
        select: "name tokenSymbol",
      }) as UserWithDonations[];

    const leaderboard = users
      .map((user) => {
        const fundDonations = user.donations.filter((d: Donation) => d.fundId._id.toString() === fundId);
        const totalForFund = fundDonations.reduce((sum: number, d: Donation) => sum + d.amount, 0);
        return {
          walletAddress: user.walletAddress,
          totalForFund,
        };
      })
      .sort((a, b) => b.totalForFund - a.totalForFund)
      .slice(0, 100); // Ensure top 100 after sorting

    res.status(200).json({
      fundName: fund.name,
      leaderboard,
    });
  })
);

// User profile with donation history
router.get(
  "/:walletAddress",
  asyncHandler(async (req, res) => {
    const { walletAddress } = req.params;

    const user = await User.findOne({ walletAddress }).populate({
      path: "donations.fundId",
      select: "name tokenSymbol",
    }) as UserWithDonations | null;

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const profile = {
      walletAddress: user.walletAddress,
      name: user.name || null,
      email: user.email || null,
      totalDonatedSol: user.totalDonatedSol,
      donations: user.donations.map((donation: Donation) => ({
        fundId: {
          name: donation.fundId.name,
          tokenSymbol: donation.fundId.tokenSymbol,
        },
        amount: donation.amount,
        donatedAt: donation.donatedAt.toISOString(),
      })),
    };

    res.status(200).json(profile);
  })
);

export default router;