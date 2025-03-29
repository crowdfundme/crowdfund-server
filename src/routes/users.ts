import express from "express";
import User from "../models/User";
import { asyncHandler } from "../utils/asyncHandler";

// Define interfaces for TypeScript
interface Donation {
  fundId: {
    name: string;
    tokenSymbol: string;
  };
  amount: number;
  donatedAt: Date;
}

interface UserWithDonations {
  walletAddress: string;
  totalDonatedSol: number;
  donations: Donation[];
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

// Get leaderboard of top donors
router.get(
  "/leaderboard",
  asyncHandler(async (req, res) => {
    const users = await User.find()
      .sort({ totalDonatedSol: -1 })
      .limit(10)
      .populate({
        path: "donations.fundId",
        select: "name tokenSymbol",
      }) as UserWithDonations[]; // Type assertion to match our interface

    const leaderboard = users.map((user) => ({
      walletAddress: user.walletAddress,
      totalDonatedSol: user.totalDonatedSol,
      donations: user.donations.map((donation: Donation) => ({
        fundId: {
          name: donation.fundId.name,
          tokenSymbol: donation.fundId.tokenSymbol,
        },
        amount: donation.amount,
        donatedAt: donation.donatedAt.toISOString(),
      })),
    }));

    res.status(200).json(leaderboard);
  })
);

export default router;