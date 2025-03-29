import express from "express";
import mongoose from "mongoose";
import dotenv from "dotenv";
import fundRoutes from "./routes/funds";

dotenv.config();

const app = express();
app.use(express.json());

mongoose.connect(process.env.MONGO_URI!, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
} as any).then(() => console.log("MongoDB connected")).catch(err => console.error(err));

app.use("/api/funds", fundRoutes);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));