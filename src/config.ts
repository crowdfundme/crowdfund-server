// src/config.ts

// Define an interface for type safety
interface Config {
  CROWD_FUND_CREATION_FEE: number;
  MIN_DONATION: number;
  MAX_DONATION: number;
  WEBSITE_WALLET: string;
  MONGO_URI: string;
  PORT: number;
  SOLANA_NETWORK: string;
  CLOUDINARY_CLOUD_NAME: string; // Added
  CLOUDINARY_API_KEY: string;    // Added
  CLOUDINARY_API_SECRET: string;  // Added
  SOLANA_RPC_LIVE_ENDPOINT:string;
  SOLANA_RPC_DEV_ENDPOINT:string;
}

// Function to load and validate configuration
export const getConfig = (): Config => {
  // Load environment variables (this assumes dotenv.config() has already been called)
  const config: Config = {
    CROWD_FUND_CREATION_FEE: parseFloat(process.env.CROWD_FUND_CREATION_FEE || "0.1"),
    MIN_DONATION: parseFloat(process.env.MIN_DONATION || "0.01"),
    MAX_DONATION: parseFloat(process.env.MAX_DONATION || "10"),
    WEBSITE_WALLET: process.env.WEBSITE_WALLET || "",
    MONGO_URI: process.env.MONGO_URI || "mongodb://localhost:27017/crowdfund",
    PORT: parseInt(process.env.PORT || "5000", 10),
    SOLANA_NETWORK: process.env.SOLANA_NETWORK || "devnet",
    CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME || "",
    CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY || "",
    CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET || "",
    SOLANA_RPC_LIVE_ENDPOINT: process.env.SOLANA_RPC_LIVE_ENDPOINT || "",
    SOLANA_RPC_DEV_ENDPOINT: process.env.SOLANA_RPC_DEV_ENDPOINT || "",
  };

  // Validate required environment variables
  const requiredVars = [
    "WEBSITE_WALLET",
    "MONGO_URI",
    "CLOUDINARY_CLOUD_NAME", // Added
    "CLOUDINARY_API_KEY",    // Added
    "CLOUDINARY_API_SECRET", // Added
    "SOLANA_RPC_LIVE_ENDPOINT",
    "SOLANA_RPC_DEV_ENDPOINT",
  ];
  for (const varName of requiredVars) {
    if (!config[varName as keyof Config]) {
      throw new Error(`Missing required environment variable: ${varName}`);
    }
  }

  return config;
};