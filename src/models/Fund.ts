import mongoose, { Schema } from "mongoose";

const FundSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  name: { type: String, required: true },
  image: { type: String },
  fundWalletAddress: { type: String, required: true },
  fundPrivateKey: { type: String, required: true }, // Encrypt in production
  tokenName: { type: String, required: true },
  tokenSymbol: { type: String, required: true },
  targetPercentage: { type: Number, required: true },
  targetSolAmount: { type: Number, required: true },
  currentDonatedSol: { type: Number, default: 0 },
  targetWallet: { type: String, required: true },
  status: { type: String, enum: ["active", "completed"], default: "active" },
  launchFee: { type: Number, default: 0.1 },
  tokenAddress: { type: String },
});

export default mongoose.models.Fund || mongoose.model("Fund", FundSchema);