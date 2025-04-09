// src/env.ts
import dotenv from "dotenv";
import path from "path";

const env = process.env.NODE_ENV || "development";
const dotenvFile = env === "production" ? ".env.production" : ".env";
const dotenvPath = path.resolve(process.cwd(), dotenvFile); // Use cwd for root directory
const result = dotenv.config({ path: dotenvPath });

if (result.error) {
  console.error(`Failed to load ${dotenvFile}:`, result.error);
  process.exit(1);
}

console.log(`Loaded .env from: ${dotenvPath}`);
console.log("Parsed .env:", result.parsed);
console.log("NODE_ENV after loading:", process.env.NODE_ENV);