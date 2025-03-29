import express from "express";
import User from "../models/User";
import { asyncHandler } from "../utils/asyncHandler";

const router = express.Router();

// Register or fetch user by wallet address
router.post("/register", asyncHandler(async (req, res) => {
  const { walletAddress } = req.body;
  if (!walletAddress) return res.status(400).json({ error: "Wallet address required" });

  let user = await User.findOne({ walletAddress });
  if (!user) {
    user = new User({ walletAddress });
    await user.save();
  }

  res.status(200).json({ userId: user._id, walletAddress: user.walletAddress });
}));

export default router;