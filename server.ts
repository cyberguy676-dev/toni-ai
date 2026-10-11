import express from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { GoogleGenAI, GenerateContentResponse, ThinkingLevel } from '@google/genai';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '15mb' }));

// Cross-browser CORS and security headers for iframe and standalone browser compatibility
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

// Initialize Server-Side Gemini SDK as mandated by gemini-api skill
function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured on the server.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

// Persistent & In-Memory Store for Users, Memories, Chats, and Shared Snapshots
interface UserRecord {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
  salt: string;
  createdAt: string;
  preferredLanguage: string;
  memories: string[];
  chats: any[];
}

interface SharedChatSnapshot {
  id: string;
  title: string;
  authorName: string;
  createdAt: string;
  messages: Array<{
    id: string;
    role: 'user' | 'assistant';
    content: string;
    thinking?: string;
    timestamp: string;
  }>;
}

interface DataStore {
  users: Record<string, UserRecord>;
  shares: Record<string, SharedChatSnapshot>;
}

const DATA_DIR = path.resolve(process.cwd(), '.data');
const DATA_FILE = path.join(DATA_DIR, 'toni_ai_store.json');
const TOKEN_SECRET = process.env.SESSION_SECRET || 'toni-ai-zain-shoaib-secure-hmac-key-2026';

let memoryStore: DataStore = {
  users: {},
  shares: {},
};

function loadStore(): DataStore {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        memoryStore = {
          users: parsed.users || {},
          shares: parsed.shares || {},
        };
      }
    }
  } catch (err) {
    // Fallback to in-memory store if filesystem is read-only
  }
  return memoryStore;
}

function saveStore(): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(DATA_FILE, JSON.stringify(memoryStore, null, 2), 'utf-8');
  } catch (err) {
    // Keep operating in memory if disk write is restricted
  }
}

loadStore();

// Cryptographic helpers for secure authentication
function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function createAuthToken(userId: string, email: string): string {
  const payload = Buffer.from(
    JSON.stringify({
      sub: userId,
      email,
      iat: Date.now(),
      exp: Date.now() + 1000 * 60 * 60 * 24 * 30, // 30 days
    })
  ).toString('base64url');
  const signature = crypto
    .createHmac('sha256', TOKEN_SECRET)
    .update(payload)
    .digest('base64url');
  return `${payload}.${signature}`;
}

function verifyAuthToken(token?: string): { sub: string; email: string } | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;
  const expectedSig = crypto
    .createHmac('sha256', TOKEN_SECRET)
    .update(payload)
    .digest('base64url');
  if (signature !== expectedSig) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
    if (decoded.exp && decoded.exp < Date.now()) return null;
    return { sub: decoded.sub, email: decoded.email };
  } catch {
    return null;
  }
}

function getAuthenticatedUser(req: express.Request): UserRecord | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7).trim();
  const verified = verifyAuthToken(token);
  if (!verified) return null;
  return memoryStore.users[verified.sub] || null;
}

// Automatic personal memory extractor from user messages
function extractPotentialMemories(userMessage: string, existingMemories: string[]): string[] {
  const trimmed = userMessage.trim();
  if (!trimmed || trimmed.length > 350) return [];

  const patterns: Array<{ regex: RegExp; prefix: string }> = [
    { regex: /\b(?:my name is|mera naam|main|i am called)\s+([A-Za-z\s]{2,30}?)(?:\s+hai|\s+hoon|[.,!]|$)/i, prefix: 'User name: ' },
    { regex: /\b(?:i work as|i am a|main ek|mera kaam|my profession is)\s+([A-Za-z0-9\s\-/]{3,45}?)(?:\s+hai|\s+hoon|[.,!]|$)/i, prefix: 'Role/Background: ' },
    { regex: /\b(?:i live in|main\s+([A-Za-z\s]{2,25})\s+mein rehta|i am from|mera shehar)\s*([A-Za-z\s]{2,30}?)(?:[.,!]|$)/i, prefix: 'Location: ' },
    { regex: /\b(?:remember that|yaad rakhna ke|yaad rakho|please remember)\s+(.{4,120})/i, prefix: 'Note: ' },
    { regex: /\b(?:i prefer|mujhe\s+.{3,50}\s+pasand hai|always reply in|hamesha\s+.{3,35}\s+mein jawab)/i, prefix: 'Preference: ' },
  ];

  const added: string[] = [];
  for (const { regex, prefix } of patterns) {
    const match = trimmed.match(regex);
    if (match) {
      const value = (match[1] || match[2] || match[0]).trim();
      if (value && value.length >= 2) {
        const fact = `${prefix}${value}`;
        const exists = existingMemories.some(
          (m) => m.toLowerCase() === fact.toLowerCase()
        );
        if (!exists && existingMemories.length + added.length < 40) {
          added.push(fact);
        }
      }
    }
  }
  return added;
}

// Health & App Info Endpoint
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    appName: 'Toni AI',
    developer: 'Zain Shoaib',
    sharedUrl:
      process.env.APP_URL && process.env.APP_URL !== 'MY_APP_URL'
        ? process.env.APP_URL
        : 'https://ais-pre-bf4ifz7vuunwfw7rgyaqp6-141936080448.asia-east1.run.app',
  });
});

// Authentication: Register
app.post('/api/auth/register', (req, res) => {
  try {
    const { name, email, password, chats, memories, preferredLanguage } = req.body || {};
    if (!name || !email || !password) {
      res.status(400).json({ error: 'Name, email, and password are required.' });
      return;
    }
    const normalizedEmail = String(email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      res.status(400).json({ error: 'Please enter a valid email address.' });
      return;
    }
    if (String(password).length < 6) {
      res.status(400).json({ error: 'Password must be at least 6 characters long.' });
      return;
    }

    const existingUser = Object.values(memoryStore.users).find(
      (u) => u.email.toLowerCase() === normalizedEmail
    );
    if (existingUser) {
      res.status(409).json({ error: 'An account with this email already exists. Please sign in.' });
      return;
    }

    const id = 'usr_' + crypto.randomBytes(8).toString('hex');
    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = hashPassword(String(password), salt);

    const newUser: UserRecord = {
      id,
      name: String(name).trim().slice(0, 60),
      email: normalizedEmail,
      passwordHash,
      salt,
      createdAt: new Date().toISOString(),
      preferredLanguage: preferredLanguage || 'Auto (Roman Urdu & All Languages)',
      memories: Array.isArray(memories)
        ? memories.slice(0, 40)
        : [`User Name: ${String(name).trim().slice(0, 60)}`],
      chats: Array.isArray(chats) ? chats.slice(0, 50) : [],
    };

    memoryStore.users[id] = newUser;
    saveStore();

    const token = createAuthToken(newUser.id, newUser.email);
    res.json({
      token,
      user: {
        id: newUser.id,
        name: newUser.name,
        email: newUser.email,
        createdAt: newUser.createdAt,
        preferredLanguage: newUser.preferredLanguage,
        memories: newUser.memories,
        chats: newUser.chats,
      },
    });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Registration failed.' });
  }
});

// Authentication: Login
app.post('/api/auth/login', (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required.' });
      return;
    }
    const normalizedEmail = String(email).trim().toLowerCase();
    const user = Object.values(memoryStore.users).find(
      (u) => u.email.toLowerCase() === normalizedEmail
    );
    if (!user) {
      res.status(401).json({ error: 'Invalid email or password.' });
      return;
    }

    const candidateHash = hashPassword(String(password), user.salt);
    const valid = crypto.timingSafeEqual(
      Buffer.from(candidateHash, 'hex'),
      Buffer.from(user.passwordHash, 'hex')
    );
    if (!valid) {
      res.status(401).json({ error: 'Invalid email or password.' });
      return;
    }

    const token = createAuthToken(user.id, user.email);
    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        createdAt: user.createdAt,
        preferredLanguage: user.preferredLanguage,
        memories: user.memories,
        chats: user.chats,
      },
    });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Sign in failed.' });
  }
});

// Get current session user
app.get('/api/auth/me', (req, res) => {
  const user = getAuthenticatedUser(req);
  if (!user) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  res.json({
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      createdAt: user.createdAt,
      preferredLanguage: user.preferredLanguage,
      memories: user.memories,
      chats: user.chats,
    },
  });
});

// Sync user chats & memories
app.post('/api/user/sync', (req, res) => {
  const user = getAuthenticatedUser(req);
  if (!user) {
    res.status(401).json({ error: 'Authentication required to sync cloud state.' });
    return;
  }
  const { chats, memories, preferredLanguage } = req.body || {};
  if (Array.isArray(chats)) {
    user.chats = chats.slice(0, 100);
  }
  if (Array.isArray(memories)) {
    user.memories = memories.slice(0, 60);
  }
  if (typeof preferredLanguage === 'string') {
    user.preferredLanguage = preferredLanguage;
  }
  saveStore();
  res.json({
    ok: true,
    memories: user.memories,
    preferredLanguage: user.preferredLanguage,
  });
});

// Create a shareable conversation link so others can open & view in any browser
app.post('/api/share', (req, res) => {
  try {
    const { title, authorName, messages } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ error: 'Cannot share an empty conversation.' });
      return;
    }
    const id = crypto.randomBytes(5).toString('hex');
    const snapshot: SharedChatSnapshot = {
      id,
      title: String(title || 'Toni AI Conversation').slice(0, 100),
      authorName: String(authorName || 'Toni AI User').slice(0, 50),
      createdAt: new Date().toISOString(),
      messages: messages.slice(0, 60).map((m: any) => ({
        id: String(m.id || crypto.randomUUID()),
        role: m.role === 'user' ? 'user' : 'assistant',
        content: String(m.content || ''),
        thinking: m.thinking ? String(m.thinking) : undefined,
        timestamp: String(m.timestamp || new Date().toISOString()),
      })),
    };
    memoryStore.shares[id] = snapshot;
    saveStore();
    res.json({ shareId: id, snapshot });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to create share link.' });
  }
});

// Retrieve a shared conversation snapshot
app.get('/api/share/:id', (req, res) => {
  const share = memoryStore.shares[req.params.id];
  if (!share) {
    res.status(404).json({ error: 'Shared conversation not found.' });
    return;
  }
  res.json({ snapshot: share });
});

// Main Gemini AI Chat Endpoint
app.post('/api/chat', async (req, res) => {
  try {
    const {
      messages,
      memories = [],
      preferredLanguage = 'Auto',
      deepThink = false,
      webSearch = false,
      userName = '',
      imageAttachment = null,
    } = req.body || {};

    if (!Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ error: 'Messages array is required.' });
      return;
    }

    const ai = getGeminiClient();

    // Combine authenticated user memories with client-supplied memories
    const authUser = getAuthenticatedUser(req);
    const combinedMemories = Array.from(
      new Set([
        ...(authUser?.memories || []),
        ...(Array.isArray(memories) ? memories : []),
      ])
    ).slice(0, 40);

    const lastUserMessage = messages[messages.length - 1]?.content || '';
    const newlyExtractedMemories = extractPotentialMemories(
      String(lastUserMessage),
      combinedMemories
    );

    if (newlyExtractedMemories.length > 0 && authUser) {
      authUser.memories = [...authUser.memories, ...newlyExtractedMemories];
      saveStore();
    }

    const allActiveMemories = [...combinedMemories, ...newlyExtractedMemories];

    const memoryContextBlock =
      allActiveMemories.length > 0
        ? `\n\nLONG-TERM USER MEMORY (Remember these facts about the user naturally across conversations):\n${allActiveMemories
            .map((m, i) => `${i + 1}. ${m}`)
            .join('\n')}`
        : '';

    const languageDirective =
      preferredLanguage === 'Roman Urdu'
        ? 'The user prefers ROMAN URDU (Urdu written in Latin/English alphabet, e.g., "Aap kaise hain? Main aap ki har tarah se madad kar sakta hoon."). Respond naturally in clear, friendly, high-quality Roman Urdu unless explicitly asked for another language.'
        : preferredLanguage === 'Urdu Script'
        ? 'The user prefers URDU SCRIPT (اردو). Respond naturally in fluent Urdu script.'
        : preferredLanguage === 'English'
        ? 'The user prefers ENGLISH. Respond in clear, articulate English unless the user explicitly asks you to translate or use Roman Urdu.'
        : 'AUTO-DETECT LANGUAGE (Roman Urdu & All Languages Specialist): Automatically match the exact language and script the user writes in. If the user writes in Roman Urdu (e.g., "Bhai mujhe code samjha do", "Kya haal hai", "Ye kaise kaam karta hai?"), respond fluently and naturally in Roman Urdu. If they write in English, Urdu script (اردو), Arabic, Hindi, Spanish, French, Chinese, or any other language, respond seamlessly in that language.';

    const deepThinkDirective = deepThink
      ? `\n\nDEEPTHINK REASONING MODE IS ENABLED:
Before providing your final response, first write a concise, insightful step-by-step analytical reasoning breakdown enclosed inside <think> and </think> tags (3 to 6 bullet points or short paragraphs analyzing the user's intent, edge cases, and key concepts). Then close </think> and write your complete, well-structured final answer.`
      : '';

    const systemInstruction = `You are **Toni AI**, an advanced, deeply intelligent, warm, and versatile AI assistant created and developed by **Zain Shoaib**.

CORE IDENTITY & ATTRIBUTION:
- Name: Toni AI
- Developer & Creator: Zain Shoaib
- If anyone asks who you are, what your name is, or who created/developed/built you (in English, Roman Urdu like "tumhe kis ne banaya hai?", "tumhara developer kaun hai?", Urdu, or any language), always state clearly and proudly that you are **Toni AI**, developed by **Zain Shoaib**.

CAPABILITIES & PERSONALITY:
- You answer ALL kinds of questions: software engineering & coding, mathematics, science, academic subjects, Islamic & general knowledge, business strategy, creative writing, translation, career advice, and everyday problem-solving.
- Format responses cleanly using Markdown: use clear headings, bullet points, bold key terms, and fenced code blocks with language tags for code.
- Maintain strong conversational continuity and recall details from earlier in the conversation and from the user's Long-Term Memory.
${ userName ? `- Current User's Name: ${userName}` : '' }

LANGUAGE FLUENCY:
- ${languageDirective}${memoryContextBlock}${deepThinkDirective}`;

    // Build multi-turn contents array for Gemini (up to last 24 messages for strong memory)
    const recentMessages = messages.slice(-24);
    const contents: any[] = recentMessages.map((msg: any, idx: number) => {
      const isLast = idx === recentMessages.length - 1;
      const role = msg.role === 'user' ? 'user' : 'model';
      const parts: any[] = [];

      if (isLast && role === 'user' && imageAttachment?.data && imageAttachment?.mimeType) {
        parts.push({
          inlineData: {
            data: imageAttachment.data,
            mimeType: imageAttachment.mimeType,
          },
        });
      }

      parts.push({
        text: String(msg.content || '').trim() || 'Analyze the attached image.',
      });

      return { role, parts };
    });

    const config: any = {
      systemInstruction,
      temperature: 0.7,
    };

    if (webSearch) {
      config.tools = [{ googleSearch: {} }];
    }

    if (!deepThink) {
      config.thinkingConfig = { thinkingLevel: ThinkingLevel.LOW };
    } else {
      config.thinkingConfig = { thinkingLevel: ThinkingLevel.HIGH };
    }

    let response: GenerateContentResponse;
    try {
      response = await ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents,
        config,
      });
    } catch (primaryError: any) {
      // Fallback to gemini-flash-latest if needed
      const fallbackConfig = { ...config };
      delete fallbackConfig.thinkingConfig;
      response = await ai.models.generateContent({
        model: 'gemini-flash-latest',
        contents,
        config: fallbackConfig,
      });
    }

    let rawText = response.text || '';
    let extractedThinking = '';

    // Extract <think>...</think> block if present
    const thinkMatch = rawText.match(/<think>([\s\S]*?)<\/think>/i);
    if (thinkMatch) {
      extractedThinking = thinkMatch[1].trim();
      rawText = rawText.replace(/<think>[\s\S]*?<\/think>/i, '').trim();
    }

    // Also inspect native thought parts if returned by the model
    const candidateParts = response.candidates?.[0]?.content?.parts || [];
    for (const part of candidateParts as any[]) {
      if (part.thought && part.text && !extractedThinking) {
        extractedThinking = String(part.text).trim();
      }
    }

    // Extract Google Search grounding sources if webSearch was used
    const groundingChunks =
      (response.candidates?.[0] as any)?.groundingMetadata?.groundingChunks || [];
    const sources: Array<{ title: string; uri: string }> = [];
    for (const chunk of groundingChunks) {
      if (chunk?.web?.uri) {
        sources.push({
          title: chunk.web.title || chunk.web.uri,
          uri: chunk.web.uri,
        });
      }
    }

    res.json({
      reply: rawText || 'Main hazir hoon! Please let me know how I can help you further.',
      thinking: extractedThinking || undefined,
      sources: sources.length > 0 ? sources : undefined,
      newMemories: newlyExtractedMemories.length > 0 ? newlyExtractedMemories : undefined,
    });
  } catch (error: any) {
    console.error('Gemini chat error:', error);
    res.status(500).json({
      error:
        error?.message ||
        'An unexpected error occurred while generating the response. Please try again.',
    });
  }
});

// Ultra-Fast Streaming Chat Endpoint (SSE) for instant responses
app.post('/api/chat/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  const sendEvent = (payload: Record<string, any>) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  try {
    const {
      messages,
      memories = [],
      preferredLanguage = 'Auto',
      deepThink = false,
      webSearch = false,
      userName = '',
      imageAttachment = null,
    } = req.body || {};

    if (!Array.isArray(messages) || messages.length === 0) {
      sendEvent({ error: 'Messages array is required.' });
      res.end();
      return;
    }

    const ai = getGeminiClient();

    const authUser = getAuthenticatedUser(req);
    const combinedMemories = Array.from(
      new Set([
        ...(authUser?.memories || []),
        ...(Array.isArray(memories) ? memories : []),
      ])
    ).slice(0, 40);

    const lastUserMessage = messages[messages.length - 1]?.content || '';
    const newlyExtractedMemories = extractPotentialMemories(
      String(lastUserMessage),
      combinedMemories
    );

    if (newlyExtractedMemories.length > 0 && authUser) {
      authUser.memories = [...authUser.memories, ...newlyExtractedMemories];
      saveStore();
    }

    if (newlyExtractedMemories.length > 0) {
      sendEvent({ newMemories: newlyExtractedMemories });
    }

    const allActiveMemories = [...combinedMemories, ...newlyExtractedMemories];

    const memoryContextBlock =
      allActiveMemories.length > 0
        ? `\n\nLONG-TERM USER MEMORY:\n${allActiveMemories
            .map((m, i) => `${i + 1}. ${m}`)
            .join('\n')}`
        : '';

    const languageDirective =
      preferredLanguage === 'Roman Urdu'
        ? 'Respond naturally in clear, friendly ROMAN URDU (Urdu written in English alphabet) unless asked otherwise.'
        : preferredLanguage === 'Urdu Script'
        ? 'Respond naturally in fluent URDU SCRIPT (اردو).'
        : preferredLanguage === 'English'
        ? 'Respond in clear, articulate ENGLISH.'
        : 'AUTO-DETECT LANGUAGE: Match the language the user writes in. If they write in Roman Urdu, reply fluently in Roman Urdu. Support all languages seamlessly.';

    const deepThinkDirective = deepThink
      ? `\nFirst write a brief step-by-step reasoning inside <think>...</think> tags, then write your final answer.`
      : `\nRespond immediately, directly, and concisely with high speed and clarity.`;

    const systemInstruction = `You are **Toni AI**, an intelligent, fast AI assistant developed by **Zain Shoaib**.
- If asked your name or who created/developed you, always state you are **Toni AI**, developed by **Zain Shoaib**.
- Answer all questions accurately using clean Markdown.${userName ? `\n- User Name: ${userName}` : ''}
- ${languageDirective}${memoryContextBlock}${deepThinkDirective}`;

    const recentMessages = messages.slice(-16);
    const contents: any[] = recentMessages.map((msg: any, idx: number) => {
      const isLast = idx === recentMessages.length - 1;
      const role = msg.role === 'user' ? 'user' : 'model';
      const parts: any[] = [];

      if (isLast && role === 'user' && imageAttachment?.data && imageAttachment?.mimeType) {
        parts.push({
          inlineData: {
            data: imageAttachment.data,
            mimeType: imageAttachment.mimeType,
          },
        });
      }

      parts.push({
        text: String(msg.content || '').trim() || 'Analyze the attached image.',
      });

      return { role, parts };
    });

    const config: any = {
      systemInstruction,
      temperature: 0.65,
      thinkingConfig: {
        thinkingLevel: deepThink ? ThinkingLevel.HIGH : ThinkingLevel.LOW,
      },
    };

    if (webSearch) {
      config.tools = [{ googleSearch: {} }];
    }

    let streamResponse: AsyncGenerator<GenerateContentResponse, any, unknown>;
    try {
      streamResponse = await ai.models.generateContentStream({
        model: 'gemini-3.8-flash',
        contents,
        config,
      });
    } catch {
      const fallbackConfig = { ...config };
      delete fallbackConfig.thinkingConfig;
      streamResponse = await ai.models.generateContentStream({
        model: 'gemini-flash-latest',
        contents,
        config: fallbackConfig,
      });
    }

    const sources: Array<{ title: string; uri: string }> = [];

    for await (const chunk of streamResponse) {
      const c = chunk as GenerateContentResponse;
      const chunkText = c.text || '';
      if (chunkText) {
        sendEvent({ delta: chunkText });
      }

      const groundingChunks =
        (c.candidates?.[0] as any)?.groundingMetadata?.groundingChunks || [];
      for (const gChunk of groundingChunks) {
        if (gChunk?.web?.uri) {
          const exists = sources.some((s) => s.uri === gChunk.web.uri);
          if (!exists) {
            sources.push({
              title: gChunk.web.title || gChunk.web.uri,
              uri: gChunk.web.uri,
            });
          }
        }
      }
    }

    if (sources.length > 0) {
      sendEvent({ sources });
    }

    sendEvent({ done: true });
    res.end();
  } catch (error: any) {
    console.error('Streaming chat error:', error);
    sendEvent({
      error:
        error?.message ||
        'An unexpected error occurred while streaming the response.',
    });
    res.end();
  }
});

// Microphone Audio Transcription Endpoint using gemini-3.5-transcribe
app.post('/api/transcribe', async (req, res) => {
  try {
    const { audioBase64, mimeType = 'audio/webm', preferredLanguage = 'Auto' } = req.body || {};
    if (!audioBase64) {
      res.status(400).json({ error: 'Audio data is required.' });
      return;
    }

    const ai = getGeminiClient();
    const audioPart = {
      inlineData: {
        mimeType: String(mimeType).split(';')[0] || 'audio/webm',
        data: String(audioBase64),
      },
    };

    const langHint =
      preferredLanguage === 'Urdu Script'
        ? 'Transcribe the spoken audio accurately. If Urdu is spoken, write it in Urdu script.'
        : 'Transcribe the spoken audio accurately into text. If the speaker is speaking Urdu or Hindi, transcribe it in Roman Urdu (Latin alphabet) so they can chat naturally, or English if speaking English. Return ONLY the transcribed text without extra commentary.';

    let response: GenerateContentResponse;
    try {
      response = await ai.models.generateContent({
        model: 'gemini-3.5-transcribe',
        contents: { parts: [audioPart, { text: langHint }] },
      });
    } catch {
      response = await ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: { parts: [audioPart, { text: langHint }] },
      });
    }

    const transcript = (response.text || '').trim();
    res.json({ transcript });
  } catch (error: any) {
    console.error('Transcription error:', error);
    res.status(500).json({
      error: error?.message || 'Could not transcribe audio.',
    });
  }
});

// Optional Text-to-Speech endpoint using gemini-3.8-flash-lite-tts (Crystal-Clear Male Voice)
app.post('/api/tts', async (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text || typeof text !== 'string') {
      res.status(400).json({ error: 'Text is required for speech generation.' });
      return;
    }

    const ai = getGeminiClient();
    const cleanText = text
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/[#*_`~>|•-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 800);

    if (!cleanText) {
      res.status(400).json({ error: 'No speakable text found.' });
      return;
    }

    let response: GenerateContentResponse;
    try {
      response = await ai.models.generateContent({
        model: 'gemini-3.8-flash-lite-tts',
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: cleanText,
                speechMetadata: {
                  style: 'Clear, natural, warm, confident male voice with crisp studio audio quality',
                },
              } as any,
            ],
          },
        ],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              // 'Puck' and 'Charon' are Gemini's flagship Male voices
              prebuiltVoiceConfig: { voiceName: 'Puck' },
            },
          },
        },
      });
    } catch {
      response = await ai.models.generateContent({
        model: 'gemini-3.8-flash-lite-tts',
        contents: [
          {
            role: 'user',
            parts: [{ text: cleanText }],
          },
        ],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: 'Charon' },
            },
          },
        },
      });
    }

    const base64Audio =
      response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!base64Audio) {
      res.status(500).json({ error: 'No audio data returned.' });
      return;
    }

    res.json({ audioBase64: base64Audio, mimeType: 'audio/wav' });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'TTS generation failed.' });
  }
});

async function startServer() {
  const distPath = path.resolve(process.cwd(), 'dist');
  const distIndex = path.join(distPath, 'index.html');
  const isProd =
    process.env.NODE_ENV === 'production' ||
    process.env.npm_lifecycle_event === 'start';

  // Serve built static bundle when running in production/start and dist/index.html exists
  if (isProd && fs.existsSync(distIndex)) {
    app.use(express.static(distPath));
    app.use((_req, res) => {
      res.sendFile(distIndex);
    });
  } else {
    try {
      const { createServer: createViteServer } = await import('vite');
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: 'spa',
      });
      app.use(vite.middlewares);
    } catch {
      if (fs.existsSync(distIndex)) {
        app.use(express.static(distPath));
        app.use((_req, res) => {
          res.sendFile(distIndex);
        });
      }
    }
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Toni AI server (by Zain Shoaib) listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
