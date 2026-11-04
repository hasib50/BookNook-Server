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

// Public: all books. Supports optional category and search query.
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

// One book (public endpoint; page access is controlled in the client).
app.get("/books/:id", async (req, res) => {
  try {
    if (!validId(req.params.id)) return res.status(400).json({ message: "Invalid book ID." });
    const book = await books.findOne({ _id: new ObjectId(req.params.id) });
    if (!book) return res.status(404).json({ message: "Book not found." });
    res.json(book);
  } catch {
    res.status(500).json({ message: "Could not load this book." });
  }
});

// Add book – authenticated user is always taken from the verified token.
app.post("/books", requireAuth, async (req, res) => {
  try {
    const { title, author, category, image, description, totalCopies } = req.body;
    if (![title, author, category, image, description].every(v => typeof v === "string" && v.trim())) {
      return res.status(400).json({ message: "Please complete all book fields." });
    }
    const copies = Number(totalCopies);
    if (!Number.isInteger(copies) || copies < 1) return res.status(400).json({ message: "Total copies must be at least 1." });

    const doc = {
      title: title.trim(), author: author.trim(), category, image: image.trim(),
      description: description.trim(), totalCopies: copies, availableCopies: copies,
      addedBy: { name: req.user.name || req.user.email, email: req.user.email },
      createdAt: new Date(), updatedAt: new Date()
    };
    const result = await books.insertOne(doc);
    res.status(201).json({ ...doc, _id: result.insertedId });
  } catch {
    res.status(500).json({ message: "Could not add the book." });
  }
});

// Update – only the owner may edit.
app.patch("/books/:id", requireAuth, async (req, res) => {
  try {
    if (!validId(req.params.id)) return res.status(400).json({ message: "Invalid book ID." });
    const id = new ObjectId(req.params.id);
    const existing = await books.findOne({ _id: id });
    if (!existing) return res.status(404).json({ message: "Book not found." });
    if (existing.addedBy.email !== req.user.email) return res.status(403).json({ message: "You can only edit your own books." });

    const allowed = ["title", "author", "category", "image", "description"];
    const update = {};
    for (const key of allowed) {
      if (typeof req.body[key] === "string" && req.body[key].trim()) update[key] = req.body[key].trim();
    }
    if (req.body.totalCopies !== undefined) {
      const copies = Number(req.body.totalCopies);
      if (!Number.isInteger(copies) || copies < (existing.totalCopies - existing.availableCopies)) {
        return res.status(400).json({ message: "Total copies cannot be lower than the number currently borrowed." });
      }
      update.totalCopies = copies;
      update.availableCopies = copies - (existing.totalCopies - existing.availableCopies);
    }
    update.updatedAt = new Date();
    await books.updateOne({ _id: id }, { $set: update });
    res.json(await books.findOne({ _id: id }));
  } catch {
    res.status(500).json({ message: "Could not update the book." });
  }
});

// Delete – owner only; do not delete while active borrows exist.
app.delete("/books/:id", requireAuth, async (req, res) => {
  try {
    if (!validId(req.params.id)) return res.status(400).json({ message: "Invalid book ID." });
    const id = new ObjectId(req.params.id);
    const book = await books.findOne({ _id: id });
    if (!book) return res.status(404).json({ message: "Book not found." });
    if (book.addedBy.email !== req.user.email) return res.status(403).json({ message: "You can only delete your own books." });
    const active = await borrows.countDocuments({ bookId: id, status: "active" });
    if (active > 0) return res.status(409).json({ message: "This book has active borrows and cannot be deleted yet." });
    await books.deleteOne({ _id: id });
    res.json({ message: "Book deleted." });
  } catch {
    res.status(500).json({ message: "Could not delete the book." });
  }
});

// Borrow: atomic availability decrement and duplicate-active-borrow protection.
app.post("/borrows", requireAuth, async (req, res) => {
  const bookId = req.body.bookId;
  if (!validId(bookId)) return res.status(400).json({ message: "Invalid book ID." });
  const id = new ObjectId(bookId);
  try {
    const duplicate = await borrows.findOne({ bookId: id, userEmail: req.user.email, status: "active" });
    if (duplicate) return res.status(409).json({ message: "You already borrowed this book." });

    const book = await books.findOneAndUpdate(
      { _id: id, availableCopies: { $gt: 0 } },
      { $inc: { availableCopies: -1 } },
      { returnDocument: "after" }
    );
    if (!book) return res.status(409).json({ message: "Not available right now." });

    const borrowedAt = new Date();
    const returnAt = new Date(borrowedAt);
    returnAt.setDate(returnAt.getDate() + 7);
    const doc = {
      bookId: id, bookTitle: book.title, bookImage: book.image,
      userEmail: req.user.email, userName: req.user.name || req.user.email,
      borrowDate: borrowedAt, returnDate: returnAt, status: "active"
    };
    const result = await borrows.insertOne(doc);
    res.status(201).json({ ...doc, _id: result.insertedId });
  } catch {
    res.status(500).json({ message: "Could not borrow this book." });
  }
});


// Only the signed-in user's borrow records.
app.get("/borrows", requireAuth, async (req, res) => {
  try {
    const result = await borrows.find({ userEmail: req.user.email, status: "active" }).sort({ borrowDate: -1 }).toArray();
    res.json(result);
  } catch {
    res.status(500).json({ message: "Could not load your borrowed books." });
  }
});

// Return a book and restore one available copy.
app.delete("/borrows/:id", requireAuth, async (req, res) => {
  try {
    if (!validId(req.params.id)) return res.status(400).json({ message: "Invalid borrow ID." });
    const id = new ObjectId(req.params.id);
    const borrow = await borrows.findOne({ _id: id, userEmail: req.user.email, status: "active" });
    if (!borrow) return res.status(404).json({ message: "Active borrow not found." });
    const result = await borrows.updateOne(
      { _id: id, userEmail: req.user.email, status: "active" },
      { $set: { status: "returned", returnedAt: new Date() } }
    );
    if (!result.modifiedCount) return res.status(409).json({ message: "This book was already returned." });
    await books.updateOne({ _id: borrow.bookId }, { $inc: { availableCopies: 1 } });
    res.json({ message: "Book returned successfully." });
  } catch {
    res.status(500).json({ message: "Could not return this book." });
  }
});

async function start() {
  if (!process.env.MONGODB_URI || !process.env.JWT_SECRET) {
    throw new Error("MONGODB_URI and JWT_SECRET must be configured in server/.env");
  }
  await client.connect();
  const db = client.db(process.env.DB_NAME || "booknook");
  books = db.collection("books");
  borrows = db.collection("borrows");
  await borrows.createIndex({ bookId: 1, userEmail: 1, status: 1 });
  await books.createIndex({ createdAt: -1 });
  app.listen(PORT, () => console.log(`BookNook API running on http://localhost:${PORT}`));
}
start().catch(error => {
  console.error("Server startup failed:", error.message);
  process.exit(1);
});