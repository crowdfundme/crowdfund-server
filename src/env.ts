// src/env.ts
import dotenv from "dotenv";
import path from "path";

const env = process.env.NODE_ENV || "development";
const dotenvPath = path.resolve(__dirname, "..", env === "production" ? ".env.production" : ".env"); // Adjusted to root
const result = dotenv.config({ path: dotenvPath });

if (result.error) {
  console.error("Failed to load .env:", result.error);
  process.exit(1);
}

console.log(`Loaded .env from: ${dotenvPath}`);
console.log("Parsed .env:", result.parsed);