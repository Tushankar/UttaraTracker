const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const Chat = require('../models/Chat');

// Helper: get Gemini model
function getGeminiModel() {
  if (!process.env.GEMINI_API_KEY) return null;
  try {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    return genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
  } catch (e) {
    console.error('Gemini init error:', e.message);
    return null;
  }
}

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

// GET /api/chat — List all chats for user
router.get('/', authMiddleware, async (req, res) => {
  try {
    const chats = await Chat.find({ userId: req.user.id })
      .select('title lastActivity messages')
      .sort({ lastActivity: -1 })
      .limit(50)
      .lean();

    // Return with message count and preview
    const chatList = chats.map(c => ({
      _id: c._id,
      title: c.title,
      lastActivity: c.lastActivity,
      messageCount: c.messages?.length || 0,
      preview: c.messages?.length > 0 ? c.messages[c.messages.length - 1].content.substring(0, 80) : ''
    }));

    res.json({ chats: chatList });
  } catch (error) {
    console.error('List chats error:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/chat/:id — Get full chat by ID
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const chat = await Chat.findOne({ _id: req.params.id, userId: req.user.id });
    if (!chat) return res.status(404).json({ error: 'Chat not found' });
    res.json({ chat });
  } catch (error) {
    console.error('Get chat error:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/chat — Create new chat OR send message to existing chat
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { chatId, message, image } = req.body;

    if (!message || message.trim().length === 0) {
      return res.status(400).json({ error: 'Message is required' });
    }

    let chat;
    if (chatId) {
      chat = await Chat.findOne({ _id: chatId, userId: req.user.id });
      if (!chat) return res.status(404).json({ error: 'Chat not found' });
    } else {
      // Create new chat
      chat = new Chat({
        userId: req.user.id,
        title: message.substring(0, 50) + (message.length > 50 ? '...' : ''),
        messages: []
      });
    }

    // Add user message
    const userMsg = { role: 'user', content: message, timestamp: new Date() };
    if (image) userMsg.image = image;
    chat.messages.push(userMsg);

    // Generate AI response
    let aiResponse = '';
    const model = getGeminiModel();

    if (model) {
      try {
        // Build conversation history for context
        const history = chat.messages.slice(-10).map(m => ({
          role: m.role === 'user' ? 'user' : 'model',
          parts: [{ text: m.content }]
        }));

        // If there's an image, use multimodal
        if (image) {
          const parts = [{ text: `${SYSTEM_PROMPT}\n\nUser message: ${message}` }];

          // Parse base64 image
          const imageMatch = image.match(/^data:(image\/\w+);base64,(.+)$/);
          if (imageMatch) {
            parts.push({
              inlineData: {
                mimeType: imageMatch[1],
                data: imageMatch[2]
              }
            });
          }

          const result = await model.generateContent(parts);
          aiResponse = result.response.text();
        } else {
          // Text-only chat with history
          const chatSession = model.startChat({
            history: history.length > 1 ? history.slice(0, -1) : [],
            systemInstruction: SYSTEM_PROMPT
          });

          const result = await chatSession.sendMessage(message);
          aiResponse = result.response.text();
        }
      } catch (aiError) {
        console.error('Gemini chat error:', aiError.message);
        aiResponse = getFallbackResponse(message);
      }
    } else {
      aiResponse = getFallbackResponse(message);
    }

    // Add assistant response
    chat.messages.push({
      role: 'assistant',
      content: aiResponse,
      timestamp: new Date()
    });

    await chat.save();

    res.json({
      chatId: chat._id,
      title: chat.title,
      reply: aiResponse,
      messageCount: chat.messages.length
    });
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/chat/:id — Delete a chat
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    await Chat.findOneAndDelete({ _id: req.params.id, userId: req.user.id });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fallback responses when Gemini is unavailable
function getFallbackResponse(message) {
  const msg = message.toLowerCase();

  if (msg.includes('percentage') || msg.includes('percent')) {
    return "📊 **Percentage Tips:**\n\n• Percentage = (Part/Whole) × 100\n• Increase: New = Original × (1 + %/100)\n• Decrease: New = Original × (1 - %/100)\n• Successive %: A% then B% = (A + B + AB/100)%\n\nWant me to explain any of these with examples?";
  }
  if (msg.includes('ratio') || msg.includes('proportion')) {
    return "⚖️ **Ratio & Proportion:**\n\n• Ratio a:b means a/b\n• If a:b = c:d, then ad = bc (cross multiplication)\n• Componendo-Dividendo: (a+b)/(a-b) = (c+d)/(c-d)\n\nPractice these daily — they appear in almost every SSC exam! 📝";
  }
  if (msg.includes('tense') || msg.includes('grammar')) {
    return "📖 **English Grammar Tips:**\n\n• Present Simple: He goes (habitual)\n• Present Continuous: He is going (now)\n• Present Perfect: He has gone (completed)\n• Past Perfect: He had gone (before another past)\n\nRemember: SSC loves testing tense consistency! Keep practicing 💪";
  }
  if (msg.includes('hello') || msg.includes('hi') || msg.includes('hey')) {
    return "Hey Uttara! 👋 I'm your SSC Study Buddy! Ask me anything about:\n\n📊 Quant concepts & shortcuts\n📖 English grammar rules\n🧩 Reasoning tricks\n🌍 GK facts & current affairs\n\nOr send me a photo of a question and I'll help solve it! 📸";
  }
  if (msg.includes('motivat') || msg.includes('tired') || msg.includes('bore')) {
    return "💪 **You've got this, Uttara!**\n\nRemember:\n• Every hour you study is one step closer to your dream job\n• SSC CGL is tough, but you're tougher!\n• Take small breaks, drink water, and come back stronger\n• Tushankar believes in you — don't let him down! 🔥\n\nNow let's get back to studying! What topic should we tackle? 📚";
  }

  return "I'm your SSC Study Buddy! 📚 I can help with:\n\n• **Quant**: Percentage, Ratio, Algebra, Geometry concepts\n• **English**: Grammar rules, vocabulary, comprehension\n• **Reasoning**: Patterns, puzzles, logical deduction\n• **GK**: Facts, current affairs, static GK\n• **Image Analysis**: Send me a photo of any question!\n\nWhat would you like to study today? ✨";
}

module.exports = router;
