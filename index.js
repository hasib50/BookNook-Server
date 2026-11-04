import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import { MongoClient, ObjectId } from "mongodb";

import dns from "node:dns";

dns.setServers(["8.8.8.8", "8.8.4.4"]);

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const client = new MongoClient(process.env.MONGODB_URI);
let books;
let borrows;

app.use(cors({
  origin: (process.env.CLIENT_ORIGIN || "http://localhost:3000").split(","),
  credentials: true
}));
app.use(express.json({ limit: "2mb" }));

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return res.status(401).json({ message: "Authentication required." });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ message: "Your session has expired. Please sign in again." });
  }
}

function validId(id) {
  return ObjectId.isValid(id);
}

app.get("/health", (_req, res) => res.json({ status: "ok", service: "BookNook API" }));

// Public: all books. Supports optional category and search query for.
app.get("/books", async (req, res) => {
  try {
    const filter = {};
    if (req.query.category && req.query.category !== "All") filter.category = req.query.category;
    if (req.query.search) {
      const term = String(req.query.search).trim();
      filter.$or = [
        { title: { $regex: term, $options: "i" } },
        { author: { $regex: term, $options: "i" } }
      ];
    }
    const limit = Math.min(Number(req.query.limit) || 100, 100);
    const result = await books.find(filter).sort({ createdAt: -1 }).limit(limit).toArray();
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: "Could not load books." });
  }
});



