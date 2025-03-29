import mongoose, { Schema } from "mongoose";

// Ensure the environment variable is a number
const CROWD_FUND_CREATION_FEE = parseFloat(process.env.CROWD_FUND_CREATION_FEE || "0.1");

const FundSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String, required: true },
    image: { type: String },
    fundWalletAddress: { type: String, required: true },
    fundPrivateKey: { type: String, required: true }, // Encrypt in production
    tokenName: { type: String, required: true },
    tokenSymbol: { type: String, required: true },
    tokenDescription: { type: String, required: true },
    targetPercentage: { type: Number, required: true },
    targetSolAmount: { type: Number, required: true },
    currentDonatedSol: { type: Number, default: 0 }, // Only donations from other users
    initialFeePaid: { type: Number, default: 0 }, // Tracks the creation fee
    targetWallet: { type: String, required: true },
    tokenTwitter: { type: String, required: false },
    tokenTelegram: { type: String, required: false },
    tokenWebsite: { type: String, required: false },
    status: { type: String, enum: ["active", "completed"], default: "active" },
    launchFee: { type: Number, default: CROWD_FUND_CREATION_FEE },
    tokenAddress: { type: String },
    completedAt: { type: Date },
  },
  { timestamps: true }
);

export default mongoose.models.Fund || mongoose.model("Fund", FundSchema);