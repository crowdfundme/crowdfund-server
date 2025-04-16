import { Keypair } from "@solana/web3.js";
import { derivePath } from "ed25519-hd-key";
import { mnemonicToSeedSync } from "bip39";
import * as bs58 from "bs58";

// Replace this with your 12- or 24-word secret phrase from Phantom
const mnemonic: string = "";
// your wallet address goes here
const expectedPublicKey: string = "";

// Convert mnemonic to seed
const seed: Buffer = mnemonicToSeedSync(mnemonic);

// Derive the Solana keypair (m/44'/501'/0'/0' is the default path for Solana in Phantom)
const derivedSeed: Buffer = derivePath("m/44'/501'/0'/0'", seed.toString("hex")).key;
const keypair: Keypair = Keypair.fromSeed(derivedSeed.slice(0, 32)); // Solana uses first 32 bytes of seed

console.log("Public Key:", keypair.publicKey.toBase58());
console.log("Private Key (Base58):", bs58.default.encode(keypair.secretKey));

// Verify it matches your expected public key
if (keypair.publicKey.toBase58() === expectedPublicKey) {
  console.log("Success! The derived public key matches your WEBSITE_WALLET.");
} else {
  console.error("Error: The derived public key does NOT match your WEBSITE_WALLET.");
}