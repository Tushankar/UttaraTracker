const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../middleware/auth");
const Task = require("../models/Task");

// GET all tasks for a user
router.get("/", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const tasks = await Task.find({ userId }).sort({ createdAt: -1 });
    res.json(tasks);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET a specific task
router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });

    // Verify ownership
    if (task.userId.toString() !== req.user.id.toString()) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    res.json(task);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// CREATE a new task
router.post("/", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { title, subject, dueDate, isRepeating, repeatInterval } = req.body;

    if (!title) return res.status(400).json({ error: "Title is required" });

    const task = new Task({
      userId,
      title,
      subject: subject || "",
      dueDate: dueDate ? new Date(dueDate) : null,
      isRepeating: isRepeating || false,
      repeatInterval: repeatInterval || "",
    });

    await task.save();
    res.status(201).json(task);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// UPDATE a task
router.put("/:id", authMiddleware, async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });

    // Verify ownership
    if (task.userId.toString() !== req.user.id.toString()) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    const { title, subject, dueDate, isRepeating, repeatInterval, completed } =
      req.body;

    if (title !== undefined) task.title = title;
    if (subject !== undefined) task.subject = subject;
    if (dueDate !== undefined)
      task.dueDate = dueDate ? new Date(dueDate) : null;
    if (isRepeating !== undefined) task.isRepeating = isRepeating;
    if (repeatInterval !== undefined) task.repeatInterval = repeatInterval;
    if (completed !== undefined) {
      task.completed = completed;
      task.completedAt = completed ? new Date() : null;
    }

    await task.save();
    res.json(task);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE a task
router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });

    // Verify ownership
    if (task.userId.toString() !== req.user.id.toString()) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    await Task.deleteOne({ _id: req.params.id });
    res.json({ message: "Task deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
