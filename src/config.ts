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
    };
  
    // Validate required environment variables
    const requiredVars = ["WEBSITE_WALLET", "MONGO_URI"];
    for (const varName of requiredVars) {
      if (!config[varName as keyof Config]) {
        throw new Error(`Missing required environment variable: ${varName}`);
      }
    }
  
    return config;
  };