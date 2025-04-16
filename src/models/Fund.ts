import mongoose, { Schema } from "mongoose";

// Ensure the environment variable is a number
const CROWD_FUND_CREATION_FEE = parseFloat(process.env.CROWD_FUND_CREATION_FEE || "0.1");

const FundSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String, required: true },
    image: { type: String }, // Cloudinary URL for the token image
    fundWalletAddress: { type: String, required: true },
    fundPrivateKey: { type: String, required: true }, // Encrypt in production
    tokenName: { type: String, required: true },
    tokenSymbol: { type: String, required: true },
    tokenDescription: { type: String, required: true },
    targetPercentage: { type: Number, required: true },
    targetSolAmount: { type: Number, required: true },
    currentDonatedSol: { type: Number, default: 0 },
    initialFeePaid: { type: Number, default: 0 },
    targetWallet: { type: String, required: true },
    tokenTwitter: { type: String, required: false },
    tokenTelegram: { type: String, required: false },
    tokenWebsite: { type: String, required: false },
    status: { type: String, enum: ["active", "completed"], default: "active" },
    launchFee: { type: Number, default: CROWD_FUND_CREATION_FEE },
    tokenAddress: { type: String },
    pumpPortalApiKey: { type: String }, // Store PumpPortal API key
    pumpPortalWalletPublicKey: { type: String }, // Store PumpPortal wallet public key
    pumpPortalPrivateKey: { type: String }, // Store PumpPortal private key
    pumpPortalTransferCompleted: { type: Boolean, default: false },
    completedAt: { type: Date },
    launchError: { type: String },
    tokenCa: { type: String },
    solscanUrl: { type: String, required: false },
    metadataUri: { type: String, required: false },
  },
  { timestamps: true }
);

export default mongoose.models.Fund || mongoose.model("Fund", FundSchema);