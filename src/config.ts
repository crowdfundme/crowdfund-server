import { Keypair, PublicKey } from "@solana/web3.js";
import * as bs58 from "bs58";
import { logInfo, logError } from "./utils/logger";

interface Config {
  CROWD_FUND_CREATION_FEE: number;
  MIN_DONATION: number;
  MAX_DONATION: number;
  WEBSITE_WALLET: string;
  WEBSITE_WALLET_KEYPAIR: Keypair;
  MONGO_URI: string;
  PORT: number;
  SOLANA_NETWORK: string;
  CLOUDINARY_CLOUD_NAME: string;
  CLOUDINARY_API_KEY: string;
  CLOUDINARY_API_SECRET: string;
  SOLANA_RPC_ENDPOINT: string;    
  FRONTEND_URL: string;
  API_KEY: string;
  MAX_IMAGE_SIZE_MB: number;
}

export const getConfig = (): Config => {
  const websiteWalletPrivateKey = process.env.WEBSITE_WALLET_PRIVATE_KEY || "";
  let websiteWalletKeypair: Keypair;
  try {
    if (!websiteWalletPrivateKey) {
      throw new Error("WEBSITE_WALLET_PRIVATE_KEY is not set in .env file.");
    }
    websiteWalletKeypair = Keypair.fromSecretKey(bs58.default.decode(websiteWalletPrivateKey));
    const expectedPublicKey = new PublicKey(process.env.WEBSITE_WALLET || "");
    if (!websiteWalletKeypair.publicKey.equals(expectedPublicKey)) {
      throw new Error("WEBSITE_WALLET and WEBSITE_WALLET_PRIVATE_KEY do not match!");
    }
    logInfo(`Loaded WEBSITE_WALLET: ${websiteWalletKeypair.publicKey.toBase58()}`);
  } catch (error) {
    logError("Error loading WEBSITE_WALLET keypair:", error);
    throw new Error(`Failed to initialize WEBSITE_WALLET: ${error instanceof Error ? error.message : "Unknown error"}. Check WEBSITE_WALLET_PRIVATE_KEY in .env.`);
  }

  const config: Config = {
    CROWD_FUND_CREATION_FEE: parseFloat(process.env.CROWD_FUND_CREATION_FEE || "0.1"),
    MIN_DONATION: parseFloat(process.env.MIN_DONATION || "0.01"),
    MAX_DONATION: parseFloat(process.env.MAX_DONATION || "10"),
    WEBSITE_WALLET: process.env.WEBSITE_WALLET || "",
    WEBSITE_WALLET_KEYPAIR: websiteWalletKeypair,
    MONGO_URI: process.env.MONGO_URI || "mongodb://localhost:27017/crowdfund",
    PORT: parseInt(process.env.PORT || "5000", 10),
    SOLANA_NETWORK: process.env.SOLANA_NETWORK || "devnet",
    CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME || "",
    CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY || "",
    CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET || "",
    SOLANA_RPC_ENDPOINT: process.env.SOLANA_RPC_ENDPOINT || "",
    FRONTEND_URL: process.env.FRONTEND_URL || "",
    API_KEY: process.env.API_KEY || "",
    MAX_IMAGE_SIZE_MB: Number(process.env.MAX_IMAGE_SIZE_MB) || 25, // Default to 25MB for testing
  };

  const requiredVars = [
    "WEBSITE_WALLET",
    "MONGO_URI",
    "CLOUDINARY_CLOUD_NAME",
    "CLOUDINARY_API_KEY",
    "CLOUDINARY_API_SECRET",
    "SOLANA_RPC_ENDPOINT",
    "FRONTEND_URL",
    "API_KEY",
  ];
  for (const varName of requiredVars) {
    if (!config[varName as keyof Config]) {
      throw new Error(`Missing required environment variable: ${varName}`);
    }
  }

  return config;
};