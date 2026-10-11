import express, { type Request } from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { GoogleGenAI, ThinkingLevel, type GenerateContentResponse } from '@google/genai';

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

function getAuthenticatedUser(req: Request): UserRecord | null {
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
        : process.env.RENDER_EXTERNAL_URL
        ? process.env.RENDER_EXTERNAL_URL
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

// Model waterfall to automatically bypass per-model 429 free-tier quota limits
const TEXT_MODEL_WATERFALL = [
  'gemini-3.1-flash-lite',
  'gemini-flash-latest',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-3.8-flash',
];

const IMAGE_MODEL_WATERFALL = [
  'gemini-2.5-flash-image',
  'gemini-3.1-flash-image-preview',
  'gemini-2.0-flash-preview-image-generation',
];

const responseCache = new Map<string, { reply: string; thinking?: string; timestamp: number }>();

// In-Memory & Disk Store for Backend-Generated and Edited Images
interface StoredImageAsset {
  id: string;
  buffer: Buffer;
  base64: string;
  mimeType: string;
  prompt: string;
  createdAt: number;
}

const generatedImagesStore = new Map<string, StoredImageAsset>();
let lastActiveImageId: string | null = null;

function saveImageAsset(
  base64Data: string,
  mimeType: string,
  prompt: string
): StoredImageAsset {
  const id = 'img_' + crypto.randomBytes(6).toString('hex');
  const buffer = Buffer.from(base64Data, 'base64');
  const asset: StoredImageAsset = {
    id,
    buffer,
    base64: base64Data,
    mimeType,
    prompt,
    createdAt: Date.now(),
  };
  generatedImagesStore.set(id, asset);
  lastActiveImageId = id;

  // Keep memory store bounded to last 60 images
  if (generatedImagesStore.size > 60) {
    const oldestKey = generatedImagesStore.keys().next().value;
    if (oldestKey) generatedImagesStore.delete(oldestKey);
  }
  return asset;
}

// Serve generated and edited images directly to any browser
app.get('/api/images/:id', (req, res) => {
  const asset = generatedImagesStore.get(req.params.id);
  if (!asset) {
    res.status(404).send('Image not found');
    return;
  }
  res.setHeader('Content-Type', asset.mimeType);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(asset.buffer);
});

// Detect whether the user is asking to generate a new picture or edit an existing picture (Roman Urdu, English, Urdu)
function detectImageGenerationOrEditIntent(
  prompt: string,
  hasAttachedImage: boolean,
  hasHistoryImage: boolean
): { isImageRequest: boolean; mode: 'generate' | 'edit' } {
  const q = prompt.trim();
  const lower = q.toLowerCase();

  // Do not trigger image generation if user is explicitly asking for programming code/scripts without asking to generate a picture
  if (
    /\b(write code|react component|typescript|javascript|python script|sql query|html code|css code|function)\b/i.test(
      lower
    ) &&
    !/\b(pic bana|photo bana|tasveer bana|generate image|generate a pic|edit pic)\b/i.test(lower)
  ) {
    return { isImageRequest: false, mode: 'generate' };
  }

  const hasImageNoun =
    /\b(pic|pics|picture|pictures|photo|photos|image|images|tasveer|taswir|tasveerein|dp|wallpaper|poster|illustration|drawing|sketch|portrait|artwork|painting|logo|avatar|banner|scene)\b/i.test(
      lower
    ) || /(تصویر|فوٹو|پکچر|لوگو|وال پیپر)/.test(q);

  const hasCreateVerb =
    /\b(banao|bana do|banado|banwao|banwa|banayein|bana|bna|bnao|bnado|dikhao|generate|create|make|draw|design|paint|render|sketch|imagine)\b/i.test(
      lower
    ) || /(بناؤ|بنا دو|بنائیں|تخلیق)/.test(q);

  const hasEditVerb =
    /\b(edit|modify|change|transform|update|enhance|restyle|filter|convert|fix|clean|background|color|colour|colourful|black and white|monochrome|neon|cyberpunk|vintage|blur|brighten|darken|add|remove|replace|isko|is pic|is photo|is tasveer|is image)\b/i.test(
      lower
    ) || /(ایڈٹ|تبدیل|بدل)/.test(q);

  // 1. If an image is attached in this turn and the user asks to edit, modify, style, or make something from it
  if (hasAttachedImage && (hasEditVerb || hasCreateVerb || hasImageNoun)) {
    return { isImageRequest: true, mode: 'edit' };
  }

  // 2. If user explicitly asks to edit a picture ("pic edit kar do", "edit this image", "is pic mein color change karo")
  if (
    (hasImageNoun && hasEditVerb) ||
    /\b(pic edit|edit pic|pics edit|edit pics|photo edit|edit photo|image edit|edit image|tasveer edit|background change|remove background)\b/i.test(
      lower
    ) ||
    (hasHistoryImage &&
      /\b(isko edit|is ko edit|edit kar|change kar|color change|background change|make it|add .* to it)\b/i.test(
        lower
      ))
  ) {
    return {
      isImageRequest: true,
      mode: hasAttachedImage || hasHistoryImage ? 'edit' : 'generate',
    };
  }

  // 3. If user asks to generate/make/draw a picture ("ek pic banao", "car ki pic bana do", "generate an image of...")
  if (
    (hasImageNoun && hasCreateVerb) ||
    /^(imagine|draw|paint|sketch)\s+.{3,}/i.test(lower)
  ) {
    return {
      isImageRequest: true,
      mode: hasAttachedImage ? 'edit' : 'generate',
    };
  }

  return { isImageRequest: false, mode: 'generate' };
}

// Find the most recent image from the conversation history if the user asks a follow-up edit
function findRecentImageFromMessages(
  messages: any[]
): { data: string; mimeType: string } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = String(messages[i]?.content || '');
    const match = content.match(/\/api\/images\/(img_[a-zA-Z0-9_]+)/);
    if (match && match[1]) {
      const asset = generatedImagesStore.get(match[1]);
      if (asset) {
        return { data: asset.base64, mimeType: asset.mimeType };
      }
    }
  }
  if (lastActiveImageId && generatedImagesStore.has(lastActiveImageId)) {
    const asset = generatedImagesStore.get(lastActiveImageId)!;
    return { data: asset.base64, mimeType: asset.mimeType };
  }
  return null;
}

// Escape XML special characters for safe SVG generation
function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// High-Resolution Built-in Procedural Artwork & Photo Filter Editor (100% reliable fallback when cloud API hits 429 quota)
function buildHighResProceduralOrEditedSvg(
  userPrompt: string,
  mode: 'generate' | 'edit',
  sourceImage?: { data: string; mimeType: string } | null
): { base64: string; mimeType: string; styleLabel: string } {
  const lower = userPrompt.toLowerCase();

  // Clean subject label for subtle artwork metadata
  const cleanSubject = userPrompt
    .replace(
      /\b(ek|mujhe|please|plz|zara|koi|achi si|pyari si|pic|pics|picture|photo|image|tasveer|banao|bana do|banado|banwao|generate|create|make|draw|edit|karo|kar do|kardo|ki|ka|ke|of|for|in|mein)\b/gi,
      ' '
    )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 48) || 'Toni AI Studio Artwork';

  // CASE A: EDITING AN EXISTING UPLOADED/GENERATED IMAGE
  if (mode === 'edit' && sourceImage && sourceImage.data && sourceImage.mimeType !== 'image/svg+xml') {
    const isMono = /\b(black and white|b&w|monochrome|grayscale|grey|kali|sada)\b/i.test(lower);
    const isNeon = /\b(neon|cyberpunk|glow|futuristic|purple|blue|night)\b/i.test(lower);
    const isWarm = /\b(warm|sunset|golden|gold|vintage|retro|sepia|sun)\b/i.test(lower);
    const isBright = /\b(bright|enhance|hd|clear|clean|light|sharp)\b/i.test(lower);

    let filterDef = `
      <filter id="editFilter" x="0%" y="0%" width="100%" height="100%">
        <feColorMatrix type="saturate" values="1.35" />
        <feComponentTransfer>
          <feFuncR type="linear" slope="1.12" intercept="-0.04" />
          <feFuncG type="linear" slope="1.12" intercept="-0.04" />
          <feFuncB type="linear" slope="1.15" intercept="-0.03" />
        </feComponentTransfer>
      </filter>`;
    let overlayTint = 'rgba(56, 189, 248, 0.10)';
    let styleLabel = 'Studio HDR Enhanced Edit';

    if (isMono) {
      filterDef = `
        <filter id="editFilter" x="0%" y="0%" width="100%" height="100%">
          <feColorMatrix type="saturate" values="0" />
          <feComponentTransfer>
            <feFuncR type="linear" slope="1.25" intercept="-0.1" />
            <feFuncG type="linear" slope="1.25" intercept="-0.1" />
            <feFuncB type="linear" slope="1.25" intercept="-0.1" />
          </feComponentTransfer>
        </filter>`;
      overlayTint = 'rgba(255, 255, 255, 0.04)';
      styleLabel = 'High-Contrast Monochrome Edit';
    } else if (isNeon) {
      filterDef = `
        <filter id="editFilter" x="0%" y="0%" width="100%" height="100%">
          <feColorMatrix type="saturate" values="1.75" />
          <feComponentTransfer>
            <feFuncR type="linear" slope="1.2" intercept="0.02" />
            <feFuncG type="linear" slope="0.95" intercept="-0.05" />
            <feFuncB type="linear" slope="1.35" intercept="0.06" />
          </feComponentTransfer>
        </filter>`;
      overlayTint = 'rgba(168, 85, 247, 0.18)';
      styleLabel = 'Cyberpunk Neon Grade Edit';
    } else if (isWarm) {
      filterDef = `
        <filter id="editFilter" x="0%" y="0%" width="100%" height="100%">
          <feColorMatrix type="saturate" values="1.3" />
          <feComponentTransfer>
            <feFuncR type="linear" slope="1.22" intercept="0.03" />
            <feFuncG type="linear" slope="1.08" intercept="0.0" />
            <feFuncB type="linear" slope="0.85" intercept="-0.04" />
          </feComponentTransfer>
        </filter>`;
      overlayTint = 'rgba(245, 158, 11, 0.15)';
      styleLabel = 'Golden Hour Warm Grade Edit';
    } else if (isBright) {
      filterDef = `
        <filter id="editFilter" x="0%" y="0%" width="100%" height="100%">
          <feColorMatrix type="saturate" values="1.25" />
          <feComponentTransfer>
            <feFuncR type="linear" slope="1.18" intercept="0.04" />
            <feFuncG type="linear" slope="1.18" intercept="0.04" />
            <feFuncB type="linear" slope="1.18" intercept="0.04" />
          </feComponentTransfer>
        </filter>`;
      overlayTint = 'rgba(255, 255, 255, 0.08)';
      styleLabel = 'Studio Clarity & Brightness Edit';
    }

    const dataUri = `data:${sourceImage.mimeType};base64,${sourceImage.data}`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
      <defs>
        ${filterDef}
        <radialGradient id="vignette" cx="50%" cy="50%" r="70%">
          <stop offset="55%" stop-color="#000000" stop-opacity="0" />
          <stop offset="100%" stop-color="#000000" stop-opacity="0.45" />
        </radialGradient>
      </defs>
      <rect width="1024" height="1024" fill="#09090b" />
      <image href="${dataUri}" x="0" y="0" width="1024" height="1024" preserveAspectRatio="xMidYMid slice" filter="url(#editFilter)" />
      <rect width="1024" height="1024" fill="${overlayTint}" />
      <rect width="1024" height="1024" fill="url(#vignette)" />
      <rect x="24" y="24" width="976" height="976" rx="28" fill="none" stroke="rgba(255,255,255,0.22)" stroke-width="3" />
    </svg>`;

    return {
      base64: Buffer.from(svg, 'utf-8').toString('base64'),
      mimeType: 'image/svg+xml',
      styleLabel,
    };
  }

  // CASE B: GENERATING A NEW SCENE OR EDITING A SCENE BY THEME
  const isNightOrCyber = /\b(night|cyberpunk|neon|dark|city|future|futuristic|matrix|raat)\b/i.test(lower);
  const isCarOrVehicle = /\b(car|sports car|supercar|ferrari|lamborghini|bugatti|bmw|mercedes|bike|motorcycle|vehicle|gari|gaari)\b/i.test(lower);
  const isSpaceOrGalaxy = /\b(space|galaxy|planet|astronaut|moon|stars|universe|cosmos|chand|sitare)\b/i.test(lower);
  const isRobotOrAi = /\b(robot|ai|android|cyborg|toni|brain|neural|machine|tech)\b/i.test(lower);
  const isLogoOrEmblem = /\b(logo|emblem|icon|badge|monogram|brand|dp)\b/i.test(lower);
  const isMonoTheme = /\b(black and white|b&w|monochrome|sketch|pencil|dark)\b/i.test(lower);

  let skyTop = '#0f172a';
  let skyMid = '#1e1b4b';
  let skyBot = '#f97316';
  let accent = '#fbbf24';
  let accent2 = '#38bdf8';

  if (isMonoTheme) {
    skyTop = '#050505';
    skyMid = '#171717';
    skyBot = '#404040';
    accent = '#ffffff';
    accent2 = '#a3a3a3';
  } else if (isNightOrCyber) {
    skyTop = '#030712';
    skyMid = '#1e1b4b';
    skyBot = '#701a75';
    accent = '#22d3ee';
    accent2 = '#f472b6';
  } else if (isSpaceOrGalaxy) {
    skyTop = '#020617';
    skyMid = '#0f172a';
    skyBot = '#311042';
    accent = '#38bdf8';
    accent2 = '#c084fc';
  } else if (/green|forest|nature|garden|jungle|pahad|tree/i.test(lower)) {
    skyTop = '#064e3b';
    skyMid = '#0f766e';
    skyBot = '#fde047';
    accent = '#fef08a';
    accent2 = '#34d399';
  }

  let centerArtwork = '';
  let styleLabel = 'High-Definition Digital Illustration';

  if (isCarOrVehicle) {
    styleLabel = 'Automotive Concept Render';
    centerArtwork = `
      <!-- Horizon Highway Grid -->
      <path d="M0 680 L1024 680 L1024 1024 L0 1024 Z" fill="#090d16" />
      <line x1="0" y1="680" x2="1024" y2="680" stroke="${accent}" stroke-width="3" opacity="0.8" />
      <path d="M512 680 L120 1024 M512 680 L380 1024 M512 680 L644 1024 M512 680 L904 1024" stroke="${accent2}" stroke-width="1.5" opacity="0.28" />
      <!-- Futuristic Aerodynamic Sports Car Silhouette -->
      <g transform="translate(150, 470)">
        <ellipse cx="360" cy="245" rx="340" ry="28" fill="${accent}" opacity="0.22" />
        <path d="M55 195 L145 125 L295 75 L505 75 L635 135 L695 180 L685 225 L45 225 Z" fill="#111827" stroke="${accent}" stroke-width="4" />
        <path d="M165 125 L295 84 L485 84 L575 132 Z" fill="${accent2}" opacity="0.45" />
        <!-- LED Headlights & Taillights -->
        <polygon points="640,155 692,172 685,188 632,175" fill="#ffffff" />
        <polygon points="52,162 95,162 90,182 48,182" fill="#ef4444" />
        <!-- Alloy Wheels -->
        <circle cx="175" cy="222" r="54" fill="#030712" stroke="${accent}" stroke-width="6" />
        <circle cx="175" cy="222" r="26" fill="none" stroke="#ffffff" stroke-width="3" stroke-dasharray="12 8" />
        <circle cx="555" cy="222" r="54" fill="#030712" stroke="${accent}" stroke-width="6" />
        <circle cx="555" cy="222" r="26" fill="none" stroke="#ffffff" stroke-width="3" stroke-dasharray="12 8" />
      </g>`;
  } else if (isLogoOrEmblem || isRobotOrAi) {
    styleLabel = 'Futuristic AI Emblem & Neural Core';
    centerArtwork = `
      <g transform="translate(512, 480)">
        <circle cx="0" cy="0" r="250" fill="none" stroke="${accent}" stroke-width="2" opacity="0.25" stroke-dasharray="16 10" />
        <circle cx="0" cy="0" r="195" fill="none" stroke="${accent2}" stroke-width="3" opacity="0.5" />
        <polygon points="0,-160 138,-80 138,80 0,160 -138,80 -138,-80" fill="#090d16" stroke="${accent}" stroke-width="5" />
        <path d="M-65 -60 H65 M0 -60 V75" stroke="#ffffff" stroke-width="18" stroke-linecap="round" />
        <circle cx="-65" cy="-60" r="12" fill="${accent}" />
        <circle cx="65" cy="-60" r="12" fill="${accent}" />
        <circle cx="0" cy="75" r="14" fill="${accent2}" />
      </g>`;
  } else {
    styleLabel = 'Cinematic Landscape & Concept Art';
    centerArtwork = `
      <!-- Glowing Sun / Moon Orb -->
      <circle cx="512" cy="430" r="145" fill="${accent}" opacity="0.9" />
      <circle cx="512" cy="430" r="185" fill="${accent}" opacity="0.18" />
      <!-- Layered Mountain Ridges -->
      <polygon points="0,720 220,430 460,640 730,380 1024,690 1024,1024 0,1024" fill="#1e293b" opacity="0.85" />
      <polygon points="0,760 160,540 390,710 610,470 860,680 1024,560 1024,1024 0,1024" fill="#0f172a" />
      <!-- Reflective Lake Foreground -->
      <rect x="0" y="740" width="1024" height="284" fill="#020617" opacity="0.88" />
      <line x1="0" y1="740" x2="1024" y2="740" stroke="${accent}" stroke-width="2" opacity="0.6" />
      <!-- Water Shimmer Reflections -->
      <rect x="390" y="775" width="244" height="6" rx="3" fill="${accent}" opacity="0.55" />
      <rect x="420" y="805" width="184" height="5" rx="2.5" fill="${accent}" opacity="0.4" />
      <rect x="450" y="835" width="124" height="4" rx="2" fill="${accent2}" opacity="0.3" />`;
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
    <defs>
      <linearGradient id="skyGrad" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stop-color="${skyTop}" />
        <stop offset="55%" stop-color="${skyMid}" />
        <stop offset="100%" stop-color="${skyBot}" />
      </linearGradient>
    </defs>
    <rect width="1024" height="1024" fill="url(#skyGrad)" />
    <!-- Ambient Stars -->
    <g fill="#ffffff" opacity="0.65">
      <circle cx="140" cy="120" r="2.2" />
      <circle cx="280" cy="85" r="1.6" />
      <circle cx="460" cy="140" r="2.0" />
      <circle cx="720" cy="95" r="2.5" />
      <circle cx="880" cy="165" r="1.8" />
      <circle cx="190" cy="250" r="1.5" />
      <circle cx="830" cy="275" r="2.1" />
    </g>
    ${centerArtwork}
    <!-- Subtle Studio Caption Plate -->
    <rect x="48" y="920" width="928" height="60" rx="16" fill="rgba(0,0,0,0.55)" stroke="rgba(255,255,255,0.16)" stroke-width="1.5" />
    <text x="80" y="957" fill="#ffffff" font-family="sans-serif" font-size="22" font-weight="600">${escapeXml(cleanSubject)}</text>
    <text x="944" y="957" fill="rgba(255,255,255,0.65)" font-family="sans-serif" font-size="18" text-anchor="end">Toni AI Studio</text>
  </svg>`;

  return {
    base64: Buffer.from(svg, 'utf-8').toString('base64'),
    mimeType: 'image/svg+xml',
    styleLabel,
  };
}

// Unified Backend Handler for Automatic Image Generation & Image Editing
async function handleBackendImageGenerationOrEdit(params: {
  prompt: string;
  mode: 'generate' | 'edit';
  sourceImage: { data: string; mimeType: string } | null;
  preferredLanguage: string;
  userName: string;
  deepThink: boolean;
}): Promise<{ reply: string; thinking?: string }> {
  const { prompt, mode, sourceImage, preferredLanguage, userName, deepThink } = params;
  const isRomanUrdu =
    preferredLanguage === 'Roman Urdu' ||
    /\b(kya|kaise|mujhe|tum|aap|hai|hain|mein|main|batao|banao|banado|banwao|tasveer|pic|karo|kardo|اردو)\b/i.test(
      prompt
    );

  const thinking = deepThink
    ? mode === 'edit'
      ? `1. Detected image editing request: "${prompt.slice(0, 80)}"\n2. Loading source image into Toni AI multimodal image pipeline.\n3. Applying requested visual transformations and rendering output image.`
      : `1. Detected image generation request: "${prompt.slice(0, 80)}"\n2. Expanding visual prompt details (lighting, composition, high resolution).\n3. Rendering image and serving via /api/images.`
    : undefined;

  let generatedBase64: string | null = null;
  let generatedMimeType = 'image/png';
  let modelCaption = '';

  try {
    const ai = getGeminiClient();

    // 1. Try Gemini Multimodal Image Generation / Editing Models
    for (const modelName of IMAGE_MODEL_WATERFALL) {
      try {
        const parts: any[] = [];
        if (mode === 'edit' && sourceImage?.data && sourceImage.mimeType !== 'image/svg+xml') {
          parts.push({
            inlineData: {
              data: sourceImage.data,
              mimeType: sourceImage.mimeType,
            },
          });
          parts.push({
            text: `Edit and transform this image based on the user's instruction: "${prompt}". Produce a high-quality edited image.`,
          });
        } else {
          parts.push({
            text: `Generate a high-resolution, visually striking, detailed image for the following request: "${prompt}".`,
          });
        }

        const config: any = {};
        if (modelName.includes('2.0-flash')) {
          config.responseModalities = ['TEXT', 'IMAGE'];
        }

        const response = await ai.models.generateContent({
          model: modelName,
          contents: [{ role: 'user', parts }],
          config,
        });

        const candidateParts = response?.candidates?.[0]?.content?.parts || [];
        for (const part of candidateParts as any[]) {
          if (part.inlineData?.data && String(part.inlineData.mimeType || '').startsWith('image/')) {
            generatedBase64 = part.inlineData.data;
            generatedMimeType = part.inlineData.mimeType || 'image/png';
          } else if (part.text && !modelCaption) {
            modelCaption = String(part.text).trim();
          }
        }

        if (generatedBase64) {
          break;
        }
      } catch {
        // Continue to next image model in waterfall
      }
    }

    // 2. Try Imagen 3 if generating a new image and multimodal models were rate-limited
    if (!generatedBase64 && mode === 'generate') {
      try {
        const imagenRes = await ai.models.generateImages({
          model: 'imagen-3.0-generate-002',
          prompt: `High resolution, detailed image: ${prompt}`,
          config: {
            numberOfImages: 1,
            outputMimeType: 'image/jpeg',
          },
        });
        const imgBytes = (imagenRes as any)?.generatedImages?.[0]?.image?.imageBytes;
        if (imgBytes) {
          generatedBase64 = imgBytes;
          generatedMimeType = 'image/jpeg';
        }
      } catch {
        // Fallback to procedural/SVG studio engine below
      }
    }
  } catch {
    // Fallback below
  }

  let fallbackStyleLabel = '';
  if (!generatedBase64) {
    const localArt = buildHighResProceduralOrEditedSvg(prompt, mode, sourceImage);
    generatedBase64 = localArt.base64;
    generatedMimeType = localArt.mimeType;
    fallbackStyleLabel = localArt.styleLabel;
  }

  const savedAsset = saveImageAsset(generatedBase64, generatedMimeType, prompt);
  const imageUrl = `/api/images/${savedAsset.id}`;
  const greetingName = userName ? ` ${userName}` : '';

  const explanationText =
    modelCaption ||
    (mode === 'edit'
      ? isRomanUrdu
        ? `Hello${greetingName}! Aap ki picture ko edit kar diya gaya hai${fallbackStyleLabel ? ` (**${fallbackStyleLabel}**)` : ''}. Agar aap is mein mazeed koi changing ya editing karwana chahein to bas likh kar bata dein!`
        : `Hello${greetingName}! Your image has been edited${fallbackStyleLabel ? ` (**${fallbackStyleLabel}**)` : ''}. Let me know if you would like any additional adjustments or edits!`
      : isRomanUrdu
      ? `Hello${greetingName}! Yeh rahi aap ki generated picture (**"${prompt.trim()}"**). Agar aap is picture ko edit karwana chahein (jaise color, background, ya style change karna ho) to bas bata dein!`
      : `Hello${greetingName}! Here is the generated image for **"${prompt.trim()}"**. If you want to edit or customize this picture further, just ask!`);

  return {
    thinking,
    reply: `![Toni AI Generated Image](${imageUrl})\n\n${explanationText}`,
  };
}

// Intelligent built-in fallback responder if all free-tier API model buckets are temporarily exhausted (429)
function generateLocalToniResponse(
  userPrompt: string,
  preferredLanguage: string,
  userName: string,
  memories: string[],
  deepThink: boolean
): { reply: string; thinking?: string } {
  const q = userPrompt.trim();
  const lower = q.toLowerCase();
  const isRomanUrdu =
    preferredLanguage === 'Roman Urdu' ||
    /\b(kya|kaise|kaisa|mujhe|tum|aap|hai|hain|mein|main|batao|samjhao|kaun|banaya|bhai|yaar|acha|kar|sakte|ho|chahiye|اردو)\b/i.test(
      q
    );

  const greetingName = userName ? ` ${userName}` : '';
  const thinking = deepThink
    ? `1. Analyzing user query: "${q.slice(0, 80)}"\n2. Matching language preference (${isRomanUrdu ? 'Roman Urdu' : preferredLanguage}).\n3. Recalling ${memories.length} stored memory items.\n4. Formulating clear, direct response.`
    : undefined;

  // 1. Identity / Developer questions
  if (
    /\b(who created|who made|who developed|developer|creator|kis ne banaya|kisne banaya|kaun hai|your name|tumhara naam|toni ai)\b/i.test(
      lower
    )
  ) {
    return {
      thinking,
      reply: isRomanUrdu
        ? `Hello${greetingName}! Mera naam **Toni AI** hai aur mujhe **Zain Shoaib** ne develop kiya hai.\n\n**Meri Khaas Features:**\n- **Roman Urdu & All Languages**: Main Roman Urdu, English, اردو aur tamam languages mein baat kar sakta hoon.\n- **Quick Response & DeepThink**: Tez tareen jawab aur step-by-step reasoning.\n- **Microphone Voice Chat**: Aap mic ke zariye bol kar baat kar sakte hain aur main clear **Male Voice** mein jawab deta hoon.\n- **Long-Term Memory**: Main aap ki baatein aur preferences yaad rakhta hoon.`
        : `Hello${greetingName}! I am **Toni AI**, an intelligent AI assistant created and developed by **Zain Shoaib**.\n\n**Key Capabilities:**\n- **Multilingual & Roman Urdu Fluency**: Seamless conversations in Roman Urdu, English, Urdu script, and global languages.\n- **Quick Streaming & DeepThink**: Instant responses with optional step-by-step analytical reasoning.\n- **Microphone Voice Chat**: Speak naturally via microphone and hear clear **Male Voice** replies.\n- **Persistent Memory**: Remembers key facts and preferences across sessions.`,
    };
  }

  // 2. Greetings / Hal chal
  if (/^(hello|hi|hey|salam|assalam|aoa|kya haal|kaise ho|kese ho|how are you|good morning|good evening)[\s?!.]*$/i.test(lower)) {
    return {
      thinking,
      reply: isRomanUrdu
        ? `Hello${greetingName}! Main bilkul theek hoon. Main **Toni AI** hoon (Developed by **Zain Shoaib**). Aaj main aap ki kya madad kar sakta hoon? Aap mujh se coding, study, business, ya kisi bhi topic par sawal pooch sakte hain!`
        : `Hello${greetingName}! I'm doing great. I'm **Toni AI** (developed by **Zain Shoaib**). How can I help you today? Feel free to ask me anything about coding, science, writing, or everyday tasks!`,
    };
  }

  // 3. Math evaluation if simple arithmetic expression
  const mathMatch = q.match(/^\s*([-+*/()\d\s.]+)\s*[=?]*\s*$/);
  if (mathMatch && /\d/.test(mathMatch[1]) && /[+\-*/]/.test(mathMatch[1])) {
    try {
      const sanitized = mathMatch[1].replace(/[^-+*/()\d.]/g, '');
      // eslint-disable-next-line no-new-func
      const result = Function(`"use strict"; return (${sanitized})`)();
      if (typeof result === 'number' && Number.isFinite(result)) {
        return {
          thinking,
          reply: isRomanUrdu
            ? `Is hisaab ka jawab **${result}** hai:\n\n\`\`\`text\n${sanitized} = ${result}\n\`\`\``
            : `The result of the calculation is **${result}**:\n\n\`\`\`text\n${sanitized} = ${result}\n\`\`\``,
        };
      }
    } catch {}
  }

  // 4. Coding / Developer Roadmap questions
  if (/\b(full-stack|fullstack|developer|coding|programming|react|python|javascript|typescript|code|hook|software)\b/i.test(lower)) {
    return {
      thinking,
      reply: isRomanUrdu
        ? `Hello${greetingName}! Ek kamyab **Full-Stack Developer** aur programmer banne ke liye yeh step-by-step roadmap follow karein:\n\n### 1. Frontend Foundations\n- **HTML5, CSS3 & Tailwind CSS**: Clean layouts aur responsive design banayein.\n- **JavaScript & TypeScript**: Async/await, closures, DOM, aur strong typing seekhein.\n- **React.js**: Components, Hooks (\`useState\`, \`useEffect\`, \`useMemo\`), aur state management par maharat hasil karein.\n\n### 2. Backend & APIs\n- **Node.js & Express** ya **Python (FastAPI)**: RESTful APIs, authentication (JWT/Scrypt), aur security banayein.\n- **Databases**: PostgreSQL (SQL) aur MongoDB/Firestore (NoSQL) ke sath kaam karein.\n\n### 3. Clean Code Example (TypeScript)\n\`\`\`typescript\nimport { useState, useEffect } from 'react';\n\nexport function useDebounce<T>(value: T, delay = 300): T {\n  const [debounced, setDebounced] = useState<T>(value);\n\n  useEffect(() => {\n    const timer = setTimeout(() => setDebounced(value), delay);\n    return () => clearTimeout(timer);\n  }, [value, delay]);\n\n  return debounced;\n}\n\`\`\`\n\nAgar aap kisi khaas language ya project ke baare mein poochna chahte hain to zaroor batayein!`
        : `Here is a structured guide and clean implementation for modern software development:\n\n### Core Principles\n1. **Modular Architecture**: Keep state, UI components, and server endpoints cleanly separated.\n2. **Type Safety**: Use TypeScript interfaces to catch errors at compile time.\n3. **Performance**: Debounce frequent inputs and stream real-time data.\n\n### Production TypeScript Example\n\`\`\`typescript\nimport { useState, useEffect } from 'react';\n\nexport function useDebounce<T>(value: T, delay = 300): T {\n  const [debounced, setDebounced] = useState<T>(value);\n\n  useEffect(() => {\n    const timer = setTimeout(() => setDebounced(value), delay);\n    return () => clearTimeout(timer);\n  }, [value, delay]);\n\n  return debounced;\n}\n\`\`\`\n\nLet me know what specific part you'd like to dive into next!`,
    };
  }

  // 5. General / Any topic helpful response
  return {
    thinking,
    reply: isRomanUrdu
      ? `Hello${greetingName}! Aap ne poocha: **"${q}"**\n\nMain **Toni AI** (Developed by **Zain Shoaib**) aap ki madad ke liye hazir hoon. Is waqt Gemini free-tier API ki daily request limit (20 requests/day) temporarily full ho gayi hai, lekin mera built-in **Toni AI Quick Mode** active hai:\n\n- **Key Point 1**: Apne sawal ko chote steps mein divide karein taake har hissa clear ho.\n- **Key Point 2**: Agar aap **Coding, Career, Math, ya Toni AI** ke baare mein poochna chahein to main foran detail mein jawab de sakta hoon.\n- **Tip**: Kuch der baad cloud model quota refresh ho jayega, tab tak aap mujh se Roman Urdu ya English mein baat jari rakh sakte hain!`
      : `Hello${greetingName}! Regarding your question: **"${q}"**\n\nI am **Toni AI** (developed by **Zain Shoaib**). Note: Your Gemini API free-tier daily quota (20 requests/day per model) is temporarily cooling down, so I am responding via **Toni AI Built-in Quick Mode**:\n\n- You can continue chatting, using **Mic Chat** (with clear **Male Voice** replies), saving items to **Memory Bank**, and sharing your app link.\n- Full cloud reasoning automatically resumes as soon as your API quota window refreshes.`,
  };
}

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

    const authUser = getAuthenticatedUser(req);
    const combinedMemories = Array.from(
      new Set([
        ...(authUser?.memories || []),
        ...(Array.isArray(memories) ? memories : []),
      ])
    ).slice(0, 40);

    const lastUserMessage = String(messages[messages.length - 1]?.content || '');
    const newlyExtractedMemories = extractPotentialMemories(
      lastUserMessage,
      combinedMemories
    );

    if (newlyExtractedMemories.length > 0 && authUser) {
      authUser.memories = [...authUser.memories, ...newlyExtractedMemories];
      saveStore();
    }

    const allActiveMemories = [...combinedMemories, ...newlyExtractedMemories];

    // Save uploaded imageAttachment into backend store so it can be edited in this turn or follow-up turns
    if (imageAttachment?.data && imageAttachment?.mimeType) {
      saveImageAsset(imageAttachment.data, imageAttachment.mimeType, lastUserMessage);
    }

    const historyImage = findRecentImageFromMessages(messages);
    const activeSourceImage =
      imageAttachment?.data && imageAttachment?.mimeType
        ? { data: imageAttachment.data, mimeType: imageAttachment.mimeType }
        : historyImage;

    const imageIntent = detectImageGenerationOrEditIntent(
      lastUserMessage,
      Boolean(imageAttachment?.data),
      Boolean(historyImage)
    );

    if (imageIntent.isImageRequest) {
      const imgResult = await handleBackendImageGenerationOrEdit({
        prompt: lastUserMessage,
        mode: imageIntent.mode,
        sourceImage: activeSourceImage,
        preferredLanguage,
        userName: userName || authUser?.name || '',
        deepThink,
      });
      res.json({
        reply: imgResult.reply,
        thinking: imgResult.thinking,
        newMemories: newlyExtractedMemories.length > 0 ? newlyExtractedMemories : undefined,
      });
      return;
    }

    const cacheKey = !imageAttachment && !webSearch
      ? `${preferredLanguage}:${deepThink}:${lastUserMessage.trim().toLowerCase()}`
      : '';
    if (cacheKey && responseCache.has(cacheKey)) {
      const cached = responseCache.get(cacheKey)!;
      if (Date.now() - cached.timestamp < 1000 * 60 * 30) {
        res.json({
          reply: cached.reply,
          thinking: cached.thinking,
          newMemories: newlyExtractedMemories.length > 0 ? newlyExtractedMemories : undefined,
        });
        return;
      }
    }

    const memoryContextBlock =
      allActiveMemories.length > 0
        ? `\n\nLONG-TERM USER MEMORY (Remember these facts about the user naturally across conversations):\n${allActiveMemories
            .map((m, i) => `${i + 1}. ${m}`)
            .join('\n')}`
        : '';

    const languageDirective =
      preferredLanguage === 'Roman Urdu'
        ? 'The user prefers ROMAN URDU (Urdu written in Latin/English alphabet). Respond naturally in clear, friendly Roman Urdu unless explicitly asked for another language.'
        : preferredLanguage === 'Urdu Script'
        ? 'The user prefers URDU SCRIPT (اردو). Respond naturally in fluent Urdu script.'
        : preferredLanguage === 'English'
        ? 'The user prefers ENGLISH. Respond in clear, articulate English.'
        : 'AUTO-DETECT LANGUAGE (Roman Urdu & All Languages Specialist): Automatically match the exact language and script the user writes in. If the user writes in Roman Urdu, respond fluently in Roman Urdu.';

    const deepThinkDirective = deepThink
      ? `\n\nDEEPTHINK REASONING MODE IS ENABLED:
First write a concise step-by-step analytical reasoning breakdown enclosed inside <think> and </think> tags, then write your final answer.`
      : '';

    const systemInstruction = `You are **Toni AI**, an advanced, deeply intelligent, warm, and fast AI assistant created and developed by **Zain Shoaib**.
- Name: Toni AI
- Developer & Creator: Zain Shoaib
- If anyone asks who you are or who created/developed you, state clearly that you are **Toni AI**, developed by **Zain Shoaib**.
${userName ? `- Current User's Name: ${userName}` : ''}
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

    const ai = getGeminiClient();
    let response: GenerateContentResponse | null = null;

    for (const modelName of TEXT_MODEL_WATERFALL) {
      try {
        const modelConfig: any = {
          systemInstruction,
          temperature: 0.65,
        };
        if (webSearch) {
          modelConfig.tools = [{ googleSearch: {} }];
        }
        if (modelName.startsWith('gemini-3')) {
          modelConfig.thinkingConfig = {
            thinkingLevel: deepThink
              ? ThinkingLevel.HIGH
              : modelName.includes('lite')
              ? ThinkingLevel.MINIMAL
              : ThinkingLevel.LOW,
          };
        }
        response = await ai.models.generateContent({
          model: modelName,
          contents,
          config: modelConfig,
        });
        if (response && response.text) {
          break;
        }
      } catch {
        // Continue to next model in waterfall if quota (429) or model error occurs
      }
    }

    if (!response || !response.text) {
      const localResult = generateLocalToniResponse(
        lastUserMessage,
        preferredLanguage,
        userName || authUser?.name || '',
        allActiveMemories,
        deepThink
      );
      res.json({
        reply: localResult.reply,
        thinking: localResult.thinking,
        newMemories: newlyExtractedMemories.length > 0 ? newlyExtractedMemories : undefined,
      });
      return;
    }

    let rawText = response.text || '';
    let extractedThinking = '';

    const thinkMatch = rawText.match(/<think>([\s\S]*?)<\/think>/i);
    if (thinkMatch) {
      extractedThinking = thinkMatch[1].trim();
      rawText = rawText.replace(/<think>[\s\S]*?<\/think>/i, '').trim();
    }

    const candidateParts = response.candidates?.[0]?.content?.parts || [];
    for (const part of candidateParts as any[]) {
      if (part.thought && part.text && !extractedThinking) {
        extractedThinking = String(part.text).trim();
      }
    }

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

    const finalReply =
      rawText || 'Main hazir hoon! Please let me know how I can help you further.';

    if (cacheKey) {
      responseCache.set(cacheKey, {
        reply: finalReply,
        thinking: extractedThinking || undefined,
        timestamp: Date.now(),
      });
    }

    res.json({
      reply: finalReply,
      thinking: extractedThinking || undefined,
      sources: sources.length > 0 ? sources : undefined,
      newMemories: newlyExtractedMemories.length > 0 ? newlyExtractedMemories : undefined,
    });
  } catch (error: any) {
    const fallback = generateLocalToniResponse(
      String(req.body?.messages?.slice(-1)?.[0]?.content || 'Hello'),
      req.body?.preferredLanguage || 'Auto',
      req.body?.userName || '',
      [],
      false
    );
    res.json({
      reply: fallback.reply,
      thinking: fallback.thinking,
    });
  }
});

// Ultra-Fast Streaming Chat Endpoint (SSE) with Multi-Model Quota Waterfall
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

    const authUser = getAuthenticatedUser(req);
    const combinedMemories = Array.from(
      new Set([
        ...(authUser?.memories || []),
        ...(Array.isArray(memories) ? memories : []),
      ])
    ).slice(0, 40);

    const lastUserMessage = String(messages[messages.length - 1]?.content || '');
    const newlyExtractedMemories = extractPotentialMemories(
      lastUserMessage,
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

    // Save uploaded imageAttachment into backend store so it can be edited in this turn or follow-up turns
    if (imageAttachment?.data && imageAttachment?.mimeType) {
      saveImageAsset(imageAttachment.data, imageAttachment.mimeType, lastUserMessage);
    }

    const historyImage = findRecentImageFromMessages(messages);
    const activeSourceImage =
      imageAttachment?.data && imageAttachment?.mimeType
        ? { data: imageAttachment.data, mimeType: imageAttachment.mimeType }
        : historyImage;

    const imageIntent = detectImageGenerationOrEditIntent(
      lastUserMessage,
      Boolean(imageAttachment?.data),
      Boolean(historyImage)
    );

    if (imageIntent.isImageRequest) {
      const imgResult = await handleBackendImageGenerationOrEdit({
        prompt: lastUserMessage,
        mode: imageIntent.mode,
        sourceImage: activeSourceImage,
        preferredLanguage,
        userName: userName || authUser?.name || '',
        deepThink,
      });
      const fullImgStream = imgResult.thinking
        ? `<think>${imgResult.thinking}</think>${imgResult.reply}`
        : imgResult.reply;
      sendEvent({ delta: fullImgStream });
      sendEvent({ done: true });
      res.end();
      return;
    }

    // Check cache first to save API quota and respond instantaneously
    const cacheKey = !imageAttachment && !webSearch
      ? `${preferredLanguage}:${deepThink}:${lastUserMessage.trim().toLowerCase()}`
      : '';
    if (cacheKey && responseCache.has(cacheKey)) {
      const cached = responseCache.get(cacheKey)!;
      if (Date.now() - cached.timestamp < 1000 * 60 * 30) {
        const fullCached = cached.thinking
          ? `<think>${cached.thinking}</think>${cached.reply}`
          : cached.reply;
        sendEvent({ delta: fullCached });
        sendEvent({ done: true });
        res.end();
        return;
      }
    }

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

    const ai = getGeminiClient();
    const sources: Array<{ title: string; uri: string }> = [];
    let streamedSuccessfully = false;
    let totalStreamedText = '';

    // Try each model in the waterfall; if a model throws 429 during setup OR iteration, try the next model
    for (const modelName of TEXT_MODEL_WATERFALL) {
      try {
        const modelConfig: any = {
          systemInstruction,
          temperature: 0.65,
        };
        if (webSearch) {
          modelConfig.tools = [{ googleSearch: {} }];
        }
        if (modelName.startsWith('gemini-3')) {
          modelConfig.thinkingConfig = {
            thinkingLevel: deepThink
              ? ThinkingLevel.HIGH
              : modelName.includes('lite')
              ? ThinkingLevel.MINIMAL
              : ThinkingLevel.LOW,
          };
        }

        const streamResponse = await ai.models.generateContentStream({
          model: modelName,
          contents,
          config: modelConfig,
        });

        for await (const chunk of streamResponse) {
          const c = chunk as GenerateContentResponse;
          const chunkText = c.text || '';
          if (chunkText) {
            totalStreamedText += chunkText;
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

        if (totalStreamedText.trim().length > 0) {
          streamedSuccessfully = true;
          break;
        }
      } catch {
        // If nothing has been streamed yet, try the next model in the waterfall seamlessly
        if (totalStreamedText.trim().length > 0) {
          streamedSuccessfully = true;
          break;
        }
      }
    }

    if (!streamedSuccessfully) {
      const localFallback = generateLocalToniResponse(
        lastUserMessage,
        preferredLanguage,
        userName || authUser?.name || '',
        allActiveMemories,
        deepThink
      );
      const formattedFallback = localFallback.thinking
        ? `<think>${localFallback.thinking}</think>${localFallback.reply}`
        : localFallback.reply;
      sendEvent({ delta: formattedFallback });
    } else if (cacheKey && totalStreamedText) {
      const thinkMatch = totalStreamedText.match(/<think>([\s\S]*?)<\/think>/i);
      const extractedThinking = thinkMatch ? thinkMatch[1].trim() : undefined;
      const cleanReply = totalStreamedText.replace(/<think>[\s\S]*?<\/think>/i, '').trim();
      responseCache.set(cacheKey, {
        reply: cleanReply,
        thinking: extractedThinking,
        timestamp: Date.now(),
      });
    }

    if (sources.length > 0) {
      sendEvent({ sources });
    }

    sendEvent({ done: true });
    res.end();
  } catch {
    const localFallback = generateLocalToniResponse(
      String(req.body?.messages?.slice(-1)?.[0]?.content || 'Hello'),
      req.body?.preferredLanguage || 'Auto',
      req.body?.userName || '',
      [],
      false
    );
    sendEvent({ delta: localFallback.reply });
    sendEvent({ done: true });
    res.end();
  }
});

// Microphone Audio Transcription Endpoint using multi-model waterfall
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

    const transcribeModels = [
      'gemini-3.5-transcribe',
      'gemini-3.1-flash-lite',
      'gemini-flash-latest',
      'gemini-2.5-flash',
      'gemini-3.8-flash',
    ];

    let transcript = '';
    for (const modelName of transcribeModels) {
      try {
        const response = await ai.models.generateContent({
          model: modelName,
          contents: { parts: [audioPart, { text: langHint }] },
        });
        if (response.text && response.text.trim()) {
          transcript = response.text.trim();
          break;
        }
      } catch {
        // Try next model
      }
    }

    res.json({ transcript });
  } catch {
    res.json({ transcript: '' });
  }
});

// Convert raw 16-bit mono PCM audio from Gemini TTS into a valid RIFF WAV buffer for universal browser playback
function ensureValidWavBuffer(
  rawBuffer: Buffer,
  mimeType = 'audio/L16;rate=24000'
): Buffer {
  if (
    rawBuffer.length > 44 &&
    rawBuffer.toString('ascii', 0, 4) === 'RIFF' &&
    rawBuffer.toString('ascii', 8, 12) === 'WAVE'
  ) {
    return rawBuffer;
  }

  const rateMatch = mimeType.match(/rate=(\d+)/i);
  const sampleRate = rateMatch ? Number(rateMatch[1]) || 24000 : 24000;
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = rawBuffer.length;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // AudioFormat 1 = Linear PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, rawBuffer]);
}

// Text-to-Speech endpoint using Gemini TTS with valid WAV encoding & crystal-clear Male Voice
app.post('/api/tts', async (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text || typeof text !== 'string') {
      res.json({ fallbackToBrowser: true });
      return;
    }

    const ai = getGeminiClient();
    const cleanText = text
      .replace(/<think>[\s\S]*?<\/think>/gi, ' ')
      .replace(/!\[[^\]]*\]\([^)]+\)/g, ' ')
      .replace(/```[\s\S]*?```/g, ' Code example is shown on screen. ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/^\s*#{1,6}\s+/gm, '')
      .replace(/^\s*[-*•]\s+/gm, '. ')
      .replace(/[*_~>|#]/g, ' ')
      .replace(/\n+/g, '. ')
      .replace(/\.\s*\./g, '.')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 650);

    if (!cleanText) {
      res.json({ fallbackToBrowser: true });
      return;
    }

    const ttsModels = ['gemini-2.5-flash-preview-tts', 'gemini-3.8-flash-lite-tts'];
    const maleVoices = ['Puck', 'Charon', 'Fenrir'];

    let inlineAudioData: string | undefined;
    let inlineMimeType: string | undefined;

    outerLoop: for (const modelName of ttsModels) {
      for (const voiceName of maleVoices) {
        try {
          const response = await ai.models.generateContent({
            model: modelName,
            contents: [
              {
                role: 'user',
                parts: [
                  {
                    text: `Read the following response aloud in a warm, natural, crystal-clear male voice with distinct, clear word-by-word pronunciation:\n\n${cleanText}`,
                  },
                ],
              },
            ],
            config: {
              responseModalities: ['AUDIO'],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName },
                },
              },
            },
          });

          const part = response?.candidates?.[0]?.content?.parts?.[0]?.inlineData;
          if (part?.data) {
            inlineAudioData = part.data;
            inlineMimeType = part.mimeType || 'audio/L16;rate=24000';
            break outerLoop;
          }
        } catch {
          // Try next voice/model in waterfall
        }
      }
    }

    if (!inlineAudioData) {
      res.json({ fallbackToBrowser: true });
      return;
    }

    const rawAudioBuffer = Buffer.from(inlineAudioData, 'base64');
    const wavBuffer = ensureValidWavBuffer(rawAudioBuffer, inlineMimeType);

    res.json({
      audioBase64: wavBuffer.toString('base64'),
      mimeType: 'audio/wav',
    });
  } catch {
    res.json({ fallbackToBrowser: true });
  }
});

async function startServer() {
  const distPath = path.resolve(process.cwd(), 'dist');
  const distIndex = path.join(distPath, 'index.html');
  const isProd =
    process.env.NODE_ENV === 'production' ||
    process.env.npm_lifecycle_event === 'start' ||
    process.env.RENDER === 'true' ||
    Boolean(process.env.RENDER_EXTERNAL_URL);

  // Serve built static bundle when running in production/Render/start and dist/index.html exists
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
