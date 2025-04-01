import mongoose from "mongoose";
import Fund from "../models/Fund";
import * as bs58 from "bs58";
import { Keypair } from "@solana/web3.js";

async function migratePrivateKeys() {
  await mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017/crowdfund");

  const funds = await Fund.find();
  for (const fund of funds) {
    if (!fund.fundPrivateKey || typeof fund.fundPrivateKey !== "string") continue;

    try {
      // Try Base58 first
      Keypair.fromSecretKey(bs58.default.decode(fund.fundPrivateKey));
      console.log(`Fund ${fund._id} already in Base58 format`);
    } catch (base58Error) {
      try {
        // Try split format
        if (fund.fundPrivateKey.includes(",")) {
          const privateKeyArray = fund.fundPrivateKey.split(",").map(Number);
          const keypair = Keypair.fromSecretKey(Uint8Array.from(privateKeyArray));
          const base58PrivateKey = bs58.default.encode(keypair.secretKey);

          fund.fundPrivateKey = base58PrivateKey;
          await fund.save();
          console.log(`Migrated fund ${fund._id} to Base58: ${base58PrivateKey}`);
        } else {
          console.error(`Fund ${fund._id} has invalid private key format: ${fund.fundPrivateKey}`);
        }
      } catch (splitError) {
        console.error(`Failed to migrate fund ${fund._id}`, { base58Error, splitError });
      }
    }
  }

  await mongoose.disconnect();
  console.log("Migration complete");
}

migratePrivateKeys().catch(console.error);