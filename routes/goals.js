const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../middleware/auth");
const Goal = require("../models/Goal");

// GET all goals for a user
router.get("/", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const goals = await Goal.find({ userId }).sort({ createdAt: -1 });
    res.json(goals);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET a specific goal
router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const goal = await Goal.findById(req.params.id);
    if (!goal) return res.status(404).json({ error: "Goal not found" });

    // Verify ownership
    if (goal.userId.toString() !== req.user.id.toString()) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    res.json(goal);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// CREATE a new goal
router.post("/", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { title, targetHours, month } = req.body;

    if (!title || !targetHours || !month) {
      return res
        .status(400)
        .json({ error: "Title, targetHours, and month are required" });
    }

    const goal = new Goal({
      userId,
      title,
      targetHours,
      month,
    });

    await goal.save();
    res.status(201).json(goal);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// UPDATE a goal
router.put("/:id", authMiddleware, async (req, res) => {
  try {
    const goal = await Goal.findById(req.params.id);
    if (!goal) return res.status(404).json({ error: "Goal not found" });

    // Verify ownership
    if (goal.userId.toString() !== req.user.id.toString()) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    const { title, targetHours, month, achieved } = req.body;

    if (title !== undefined) goal.title = title;
    if (targetHours !== undefined) goal.targetHours = targetHours;
    if (month !== undefined) goal.month = month;
    if (achieved !== undefined) goal.achieved = achieved;

    await goal.save();
    res.json(goal);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE a goal
router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    const goal = await Goal.findById(req.params.id);
    if (!goal) return res.status(404).json({ error: "Goal not found" });

    // Verify ownership
    if (goal.userId.toString() !== req.user.id.toString()) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    await Goal.deleteOne({ _id: req.params.id });
    res.json({ message: "Goal deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
