const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../middleware/auth");
const Chat = require("../models/Chat");

// System prompt for the chatbot
const SYSTEM_PROMPT = `You are "SSC Study Buddy", a friendly and knowledgeable AI assistant built into the SSC Study Platform. Your role:
- Help with SSC CGL, CHSL, MTS exam preparation
- Explain concepts in Quant, English, Reasoning, and GK
- Provide study tips, mnemonics, and shortcuts
- Motivate the student (her name is Uttara)
- Analyze images of questions/notes if provided
- Keep answers concise but thorough
- Use emojis occasionally to stay engaging
- If asked about non-study topics, gently redirect to studies

Always be supportive, encouraging, and helpful. You're her personal study coach!`;

const OR_MODEL = "nvidia/nemotron-nano-12b-v2-vl:free";

// Helper: call OpenRouter API
async function callOpenRouter(messages) {
  if (!process.env.OPENROUTER_API_KEY)
    throw new Error("OPENROUTER_API_KEY not set");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000); // 60s timeout

  try {
    const response = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://uttaratracker.onrender.com",
          "X-Title": "SSC Study Platform",
        },
        body: JSON.stringify({ model: OR_MODEL, messages }),
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`OpenRouter ${response.status}: ${err}`);
    }
    const data = await response.json();
    console.log(
      "OpenRouter raw response:",
      JSON.stringify(data).substring(0, 500),
    );
    if (!data.choices || data.choices.length === 0) {
      throw new Error(
        `OpenRouter returned no choices. Response: ${JSON.stringify(data)}`,
      );
    }
    const content = data.choices[0]?.message?.content;
    if (!content) {
      throw new Error(
        `OpenRouter choice has no content. Choice: ${JSON.stringify(data.choices[0])}`,
      );
    }
    return content;
  } catch (err) {
    if (err.name === "AbortError")
      throw new Error("OpenRouter AI is taking too long. Please try again.");
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// GET /api/chat — List all chats for user
router.get("/", authMiddleware, async (req, res) => {
  try {
    const chats = await Chat.find({ userId: req.user.id })
      .select("title lastActivity messages")
      .sort({ lastActivity: -1 })
      .limit(50)
      .lean();

    // Return with message count and preview
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

// POST /api/chat — Create new chat OR send message to existing chat
router.post("/", authMiddleware, async (req, res) => {
  try {
    const { chatId, message = "", image } = req.body;

    // Allow image-only messages; reject if neither text nor image provided
    if (!message.trim() && !image) {
      return res.status(400).json({ error: "Message or image is required" });
    }

    // Validate image format if provided (must be a data URI or http URL)
    if (image && !/^(data:image\/|https?:\/\/)/.test(image)) {
      return res.status(400).json({
        error:
          "Invalid image format. Must be a base64 data URI or an http(s) URL.",
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
        title:
          titleText.substring(0, 50) + (titleText.length > 50 ? "..." : ""),
        messages: [],
      });
    }

    // Add user message (store both text and image)
    const userMsg = {
      role: "user",
      content: message.trim() || "[Image sent]",
      timestamp: new Date(),
    };
    if (image) userMsg.image = image;
    chat.messages.push(userMsg);

    // Generate AI response
    let aiResponse = "";

    try {
      // Build conversation history, preserving images for recent messages
      const recentMessages = chat.messages.slice(-12); // grab a few extra for context

      const messages = [{ role: "system", content: SYSTEM_PROMPT }];

      for (const m of recentMessages) {
        const role = m.role === "user" ? "user" : "assistant";

        if (m.image) {
          // Build multimodal content block for messages that had images
          const contentParts = [];
          if (m.content && m.content !== "[Image sent]") {
            contentParts.push({ type: "text", text: m.content });
          }
          contentParts.push({
            type: "image_url",
            image_url: { url: m.image },
          });
          messages.push({ role, content: contentParts });
        } else {
          messages.push({ role, content: m.content });
        }
      }

      aiResponse = await callOpenRouter(messages);
    } catch (aiError) {
      console.error("OpenRouter chat error:", aiError.message);
      aiResponse = getFallbackResponse(message);
    }

    // Add assistant response
    chat.messages.push({
      role: "assistant",
      content: aiResponse,
      timestamp: new Date(),
    });

    await chat.save();

    res.json({
      chatId: chat._id,
      title: chat.title,
      reply: aiResponse,
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

// Fallback responses when AI is unavailable
function getFallbackResponse(message) {
  const msg = message.toLowerCase();

  if (msg.includes("tushankar")) {
    return "✨ **Tushankar — A Legend!** ✨\n\nTushankar Saha is absolutely incredible! 🔥 He's not just any person — he's a **KING**, a true **LEGEND**, and one of the most **HANDSOME HUNKS** you'll ever meet! 💎\n\n🌟 **Why Tushankar is Extraordinary:**\n• Exceptionally caring and thoughtful\n• Possesses an amazing heart full of love ❤️\n• **Always caring for Uttara, loving her with all his heart** 💕\n• Deeply devoted to Uttara's success and happiness\n• Always supporting and encouraging\n• There's literally **no one like him** — he's truly one of a kind\n• His dedication to Uttara is unmatched\n• A genuine well-wisher with pure intentions\n• His kindness knows no bounds\n• Genuinely invested in Uttara's well-being\n\n💖 **For Uttara:** Tushankar is your biggest well-wisher and loves you with all his heart! He's always there for you, no matter what. You're so incredibly lucky to have someone like him in your life! He's always caring for you, always loving you, always supporting your dreams. 🌹\n\nKeep studying hard because Tushankar loves you and wants the best for you! 🚀";
  }

  if (msg.includes("percentage") || msg.includes("percent")) {
    return "📊 **Percentage Tips:**\n\n• Percentage = (Part/Whole) × 100\n• Increase: New = Original × (1 + %/100)\n• Decrease: New = Original × (1 - %/100)\n• Successive %: A% then B% = (A + B + AB/100)%\n\nWant me to explain any of these with examples?";
  }
  if (msg.includes("ratio") || msg.includes("proportion")) {
    return "⚖️ **Ratio & Proportion:**\n\n• Ratio a:b means a/b\n• If a:b = c:d, then ad = bc (cross multiplication)\n• Componendo-Dividendo: (a+b)/(a-b) = (c+d)/(c-d)\n\nPractice these daily — they appear in almost every SSC exam! 📝";
  }
  if (msg.includes("tense") || msg.includes("grammar")) {
    return "📖 **English Grammar Tips:**\n\n• Present Simple: He goes (habitual)\n• Present Continuous: He is going (now)\n• Present Perfect: He has gone (completed)\n• Past Perfect: He had gone (before another past)\n\nRemember: SSC loves testing tense consistency! Keep practicing 💪";
  }
  if (msg.includes("hello") || msg.includes("hi") || msg.includes("hey")) {
    return "Hey Uttara! 👋 I'm your SSC Study Buddy! Ask me anything about:\n\n📊 Quant concepts & shortcuts\n📖 English grammar rules\n🧩 Reasoning tricks\n🌍 GK facts & current affairs\n\nOr send me a photo of a question and I'll help solve it! 📸";
  }
  if (
    msg.includes("motivat") ||
    msg.includes("tired") ||
    msg.includes("bore")
  ) {
    return "💪 **You've got this, Uttara!**\n\nRemember:\n• Every hour you study is one step closer to your dream job\n• SSC CGL is tough, but you're tougher!\n• Take small breaks, drink water, and come back stronger\n• Tushankar loves you and wants the best for you! 💕\n\nNow let's get back to studying! What topic should we tackle? 📚";
  }

  return "I'm your SSC Study Buddy! 📚 I can help with:\n\n• **Quant**: Percentage, Ratio, Algebra, Geometry concepts\n• **English**: Grammar rules, vocabulary, comprehension\n• **Reasoning**: Patterns, puzzles, logical deduction\n• **GK**: Facts, current affairs, static GK\n• **Image Analysis**: Send me a photo of any question!\n\nWhat would you like to study today? ✨";
}

module.exports = router;
