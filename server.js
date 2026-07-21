import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import Groq from "groq-sdk";
import { createClient } from "@supabase/supabase-js";
import multer from "multer";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const upload = multer({ storage: multer.memoryStorage() });

// ---------- CHAT (streaming via Server-Sent Events) ----------
app.post("/api/chat", async (req, res) => {
  const { messages, imageUrl } = req.body;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    // If an image was sent, use the vision-capable model; otherwise the standard text model.
    // (Groq periodically deprecates older model IDs — these are the current ones as of July 2026.)
    const model = imageUrl ? "qwen/qwen3.6-27b" : "openai/gpt-oss-120b";

    const systemPrompt = {
      role: "system",
      content: `You are a helpful, sharp assistant. Follow these rules in every reply:
- Be concise. Don't pad answers with filler, restating the question, or unnecessary caveats.
- Be logical and structured. If a question has multiple parts, address each clearly.
- Give direct answers first, then brief supporting reasoning only if it adds value.
- Use plain language over jargon unless the user's question is technical.
- If you're uncertain about something, say so briefly instead of guessing confidently.
- Skip generic pleasantries — get to the substance quickly.`,
    };

    let formattedMessages = [systemPrompt, ...messages];
    if (imageUrl) {
      const last = messages[messages.length - 1];
      formattedMessages = [
        systemPrompt,
        ...messages.slice(0, -1),
        {
          role: "user",
          content: [
            { type: "text", text: last.content },
            { type: "image_url", image_url: { url: imageUrl } },
          ],
        },
      ];
    }

    const stream = await groq.chat.completions.create({
      model,
      messages: formattedMessages,
      stream: true,
    });

    let rawBuffer = "";
let pastThinking = false;

for await (const chunk of stream) {
  const token = chunk.choices[0]?.delta?.content || "";
  if (!token) continue;

  if (pastThinking) {
    res.write(`data: ${JSON.stringify({ token })}\n\n`);
    continue;
  }

  rawBuffer += token;
  const thinkEndIdx = rawBuffer.indexOf("</think>");

  if (thinkEndIdx !== -1) {
    const afterThink = rawBuffer.slice(thinkEndIdx + "</think>".length);
    pastThinking = true;
    if (afterThink) {
      res.write(`data: ${JSON.stringify({ token: afterThink })}\n\n`);
    }
  } else if (!rawBuffer.includes("<think>") && rawBuffer.length > 20) {
    pastThinking = true;
    res.write(`data: ${JSON.stringify({ token: rawBuffer })}\n\n`);
  }
}
res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
res.end();
  } catch (err) {
    console.error(err);
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

// ---------- VOICE: Speech-to-text via Groq Whisper ----------
app.post("/api/voice/stt", upload.single("audio"), async (req, res) => {
  try {
    const file = new File([req.file.buffer], "audio.m4a", { type: req.file.mimetype });
    const transcription = await groq.audio.transcriptions.create({
      file,
      model: "whisper-large-v3",
    });
    res.json({ text: transcription.text });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- IMAGE GENERATION ----------
// Uses Pollinations (free, no key required). Swap for another provider if you prefer.
app.post("/api/image/generate", async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: "prompt required" });
  const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}`;
  res.json({ imageUrl });
});

// ---------- CONVERSATIONS (persistent history via Supabase) ----------
app.get("/api/conversations", async (req, res) => {
  const { user_id } = req.query;
  const { data, error } = await supabase
    .from("conversations")
    .select("*")
    .eq("user_id", user_id)
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post("/api/conversations", async (req, res) => {
  const { user_id, title } = req.body;
  const { data, error } = await supabase
    .from("conversations")
    .insert({ user_id, title: title || "New Chat" })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get("/api/conversations/:id/messages", async (req, res) => {
  const { data, error } = await supabase
    .from("messages")
    .select("*")
    .eq("conversation_id", req.params.id)
    .order("created_at", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post("/api/conversations/:id/messages", async (req, res) => {
  const { role, content, image_url } = req.body;
  const { data, error } = await supabase
    .from("messages")
    .insert({ conversation_id: req.params.id, role, content, image_url })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete("/api/conversations/:id", async (req, res) => {
  const { error } = await supabase.from("conversations").delete().eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));