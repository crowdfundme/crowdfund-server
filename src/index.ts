import express from "express";
import mongoose from "mongoose";
import dotenv from "dotenv";
import fundRoutes from "./routes/funds";
import userRoutes from "./routes/users"; // Add this
import cors from "cors";

dotenv.config();

const app = express();

app.use(cors({
  origin: "http://localhost:3000",
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type"],
}));

app.use(express.json());

mongoose.connect(process.env.MONGO_URI!, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
} as any).then(() => console.log("MongoDB connected")).catch(err => console.error("MongoDB connection error:", err));

app.use("/api/funds", fundRoutes);
app.use("/api/users", userRoutes); // Add this

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));