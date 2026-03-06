const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../middleware/auth");
const Chat = require("../models/Chat");

// GET /api/chat — List all chats for user
router.get("/", authMiddleware, async (req, res) => {
  try {
    const chats = await Chat.find({ userId: req.user.id })
      .select("title lastActivity messages")
      .sort({ lastActivity: -1 })
      .limit(50)
      .lean();

    const chatList = chats.map((c) => ({
      _id: c._id,
      title: c.title,
      lastActivity: c.lastActivity,
      messageCount: c.messages?.length || 0,
      preview:
        c.messages?.length > 0
          ? c.messages[c.messages.length - 1].content.substring(0, 80)
          : "",
    }));

    res.json({ chats: chatList });
  } catch (error) {
    console.error("List chats error:", error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/chat/:id — Get full chat by ID
router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const chat = await Chat.findOne({
      _id: req.params.id,
      userId: req.user.id,
    });
    if (!chat) return res.status(404).json({ error: "Chat not found" });
    res.json({ chat });
  } catch (error) {
    console.error("Get chat error:", error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/chat — Save user message + AI reply (AI call happens on frontend)
router.post("/", authMiddleware, async (req, res) => {
  try {
    const { chatId, message = "", image, aiReply } = req.body;

    if (!message.trim() && !image) {
      return res.status(400).json({ error: "Message or image is required" });
    }

    // Validate image format if provided
    if (image && !/^(data:image\/|https?:\/\/)/.test(image)) {
      return res.status(400).json({
        error: "Invalid image format. Must be a base64 data URI or an http(s) URL.",
      });
    }

    let chat;
    if (chatId) {
      chat = await Chat.findOne({ _id: chatId, userId: req.user.id });
      if (!chat) return res.status(404).json({ error: "Chat not found" });
    } else {
      const titleText = message.trim() || "📸 Image question";
      chat = new Chat({
        userId: req.user.id,
        title: titleText.substring(0, 50) + (titleText.length > 50 ? "..." : ""),
        messages: [],
      });
    }

    // Add user message
    const userMsg = {
      role: "user",
      content: message.trim() || "[Image sent]",
      timestamp: new Date(),
    };
    if (image) userMsg.image = image;
    chat.messages.push(userMsg);

    // Add AI reply (sent from frontend, already generated via direct OpenRouter call)
    if (aiReply) {
      chat.messages.push({
        role: "assistant",
        content: aiReply,
        timestamp: new Date(),
      });
    }

    await chat.save();

    res.json({
      chatId: chat._id,
      title: chat.title,
      reply: aiReply || "",
      messageCount: chat.messages.length,
    });
  } catch (error) {
    console.error("Chat error:", error);
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/chat/:id — Delete a chat
router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    await Chat.findOneAndDelete({ _id: req.params.id, userId: req.user.id });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
