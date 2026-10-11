import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  PanelLeftClose,
  PanelLeft,
  Plus,
  MessageSquare,
  Trash2,
  Edit3,
  Check,
  X,
  Sun,
  Moon,
  Brain,
  Share2,
  UserCheck,
  LogIn,
  Globe,
  Cpu,
  Paperclip,
  Mic,
  ArrowUp,
  Copy,
  Volume2,
  VolumeX,
  RotateCcw,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Search,
  ShieldCheck,
  Square,
  Zap,
} from 'lucide-react';
import { ChatSession, LanguageMode, Message, UserProfile } from './types';
import {
  copyTextToClipboard,
  getShareableAppUrl,
  safeStorage,
} from './utils/storage';
import { MarkdownRenderer } from './components/MarkdownRenderer';
import { AuthModal, MemoryModal, ShareModal } from './components/Modals';
import { InteractiveLogo, playLogoFeedbackTone } from './components/InteractiveLogo';

const STORAGE_KEYS = {
  THEME: 'toni_ai_theme_v1',
  CHATS: 'toni_ai_chats_v1',
  ACTIVE_CHAT: 'toni_ai_active_chat_v1',
  MEMORIES: 'toni_ai_memories_v1',
  LANGUAGE: 'toni_ai_language_v1',
  AUTH_TOKEN: 'toni_ai_auth_token_v1',
  USER_PROFILE: 'toni_ai_user_profile_v1',
};

const STARTER_PROMPTS = [
  {
    title: 'Roman Urdu Help & Advice',
    prompt:
      'Hello Toni AI! Mujhe batao ke ek acha full-stack developer banne ke liye mujhe kis tarah step-by-step tayyari karni chahiye?',
    meta: 'Roman Urdu · Career Roadmap',
  },
  {
    title: 'Code & Architecture',
    prompt:
      'Write a clean, production-ready React custom hook for debounced search with TypeScript and explain how it works.',
    meta: 'TypeScript · Software Engineering',
  },
  {
    title: 'Explain Complex Topics Simply',
    prompt:
      'Quantum computing aur AI agents kaise kaam karte hain? Asaan Roman Urdu mein examples ke sath samjhao.',
    meta: 'Roman Urdu · Science & Tech',
  },
  {
    title: 'Who Created Toni AI?',
    prompt:
      'Toni AI tumhara developer kaun hai aur tumhari khaas features kya hain? Detail mein batao.',
    meta: 'About Toni AI · Zain Shoaib',
  },
];

export default function App() {
  // Pure Black & White Theme state (Dark = Pure Black, Light = Pure White)
  const [isDark, setIsDark] = useState<boolean>(() => {
    const saved = safeStorage.getItem(STORAGE_KEYS.THEME);
    return saved ? saved === 'dark' : true;
  });

  // Sidebar state
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(true);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState<boolean>(false);
  const [historyFilter, setHistoryFilter] = useState<string>('');

  // User Auth & Profile state
  const [user, setUser] = useState<UserProfile | null>(() => {
    try {
      const raw = safeStorage.getItem(STORAGE_KEYS.USER_PROFILE);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  });
  const [authToken, setAuthToken] = useState<string | null>(() =>
    safeStorage.getItem(STORAGE_KEYS.AUTH_TOKEN)
  );

  // Persistent Long-Term Memories
  const [memories, setMemories] = useState<string[]>(() => {
    try {
      const raw = safeStorage.getItem(STORAGE_KEYS.MEMORIES);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });

  // Language Mode (Default: Auto Roman Urdu & All Languages)
  const [preferredLanguage, setPreferredLanguage] = useState<LanguageMode>(() => {
    const saved = safeStorage.getItem(STORAGE_KEYS.LANGUAGE) as LanguageMode;
    return saved || 'Auto (Roman Urdu & All Languages)';
  });

  // Chat Sessions History
  const [chats, setChats] = useState<ChatSession[]>(() => {
    try {
      const raw = safeStorage.getItem(STORAGE_KEYS.CHATS);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });

  const [activeChatId, setActiveChatId] = useState<string | null>(() =>
    safeStorage.getItem(STORAGE_KEYS.ACTIVE_CHAT)
  );

  // Composer & Quick Response default (deepThink defaults to false for instant speed!)
  const [input, setInput] = useState<string>('');
  const [deepThink, setDeepThink] = useState<boolean>(false);
  const [webSearch, setWebSearch] = useState<boolean>(false);
  const [imageAttachment, setImageAttachment] = useState<{
    data: string;
    mimeType: string;
    preview: string;
  } | null>(null);
  const [isSending, setIsSending] = useState<boolean>(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Inline chat title editing
  const [editingChatId, setEditingChatId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState<string>('');

  // Collapsible thinking states per message ID
  const [collapsedThinking, setCollapsedThinking] = useState<Record<string, boolean>>({});
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);
  const [speakingMsgId, setSpeakingMsgId] = useState<string | null>(null);

  // Microphone Voice Chat states & Interactive Voice Reply Mode (OFF by default — replies in voice ONLY when turned ON)
  const [isRecordingMic, setIsRecordingMic] = useState<boolean>(false);
  const [isTranscribingMic, setIsTranscribingMic] = useState<boolean>(false);
  const [recordingSeconds, setRecordingSeconds] = useState<number>(0);
  const [liveSpeechDraft, setLiveSpeechDraft] = useState<string>('');
  const [voiceAutoSpeak, setVoiceAutoSpeak] = useState<boolean>(false);
  const voiceAutoSpeakRef = useRef<boolean>(false);
  const speechSessionIdRef = useRef<number>(0);
  const availableVoicesRef = useRef<SpeechSynthesisVoice[]>([]);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recognitionRef = useRef<any>(null);
  const liveSpeechDraftRef = useRef<string>('');
  const recordingTimerRef = useRef<any>(null);

  // Modals
  const [authModalOpen, setAuthModalOpen] = useState<boolean>(false);
  const [memoryModalOpen, setMemoryModalOpen] = useState<boolean>(false);
  const [shareModalOpen, setShareModalOpen] = useState<boolean>(false);

  // Refs
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage((prev) => (prev === msg ? null : prev));
    }, 2600);
  };

  // Sync theme to document root & safeStorage
  useEffect(() => {
    safeStorage.setItem(STORAGE_KEYS.THEME, isDark ? 'dark' : 'light');
    if (typeof document !== 'undefined') {
      document.documentElement.classList.toggle('dark', isDark);
    }
  }, [isDark]);

  // Persist chats, activeChatId, memories, and language locally
  useEffect(() => {
    safeStorage.setItem(STORAGE_KEYS.CHATS, JSON.stringify(chats));
  }, [chats]);

  useEffect(() => {
    if (activeChatId) {
      safeStorage.setItem(STORAGE_KEYS.ACTIVE_CHAT, activeChatId);
    } else {
      safeStorage.removeItem(STORAGE_KEYS.ACTIVE_CHAT);
    }
  }, [activeChatId]);

  useEffect(() => {
    safeStorage.setItem(STORAGE_KEYS.MEMORIES, JSON.stringify(memories));
  }, [memories]);

  useEffect(() => {
    safeStorage.setItem(STORAGE_KEYS.LANGUAGE, preferredLanguage);
  }, [preferredLanguage]);

  // Keep voiceAutoSpeakRef synchronized and preload browser speech synthesis voices for crystal-clear diction
  useEffect(() => {
    voiceAutoSpeakRef.current = voiceAutoSpeak;
  }, [voiceAutoSpeak]);

  useEffect(() => {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      const loadVoices = () => {
        const list = window.speechSynthesis.getVoices();
        if (list && list.length > 0) {
          availableVoicesRef.current = list;
        }
      };
      loadVoices();
      window.speechSynthesis.onvoiceschanged = loadVoices;
    }
  }, []);

  // Verify token on initial load and check for shared conversation URL param (?share=...)
  useEffect(() => {
    if (authToken) {
      fetch('/api/auth/me', {
        headers: { Authorization: `Bearer ${authToken}` },
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (data?.user) {
            setUser(data.user);
            safeStorage.setItem(STORAGE_KEYS.USER_PROFILE, JSON.stringify(data.user));
            if (Array.isArray(data.user.memories) && data.user.memories.length > 0) {
              setMemories((prev) =>
                Array.from(new Set([...prev, ...data.user.memories]))
              );
            }
          }
        })
        .catch(() => {});
    }

    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const shareId = params.get('share');
      if (shareId) {
        fetch(`/api/share/${encodeURIComponent(shareId)}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((data) => {
            if (data?.snapshot) {
              const importedChat: ChatSession = {
                id: 'shared_' + data.snapshot.id,
                title: `Shared: ${data.snapshot.title}`,
                createdAt: data.snapshot.createdAt,
                updatedAt: new Date().toISOString(),
                messages: data.snapshot.messages,
              };
              setChats((prev) => {
                const exists = prev.some((c) => c.id === importedChat.id);
                return exists ? prev : [importedChat, ...prev];
              });
              setActiveChatId(importedChat.id);
              showToast(`Loaded shared chat from ${data.snapshot.authorName}`);
              window.history.replaceState({}, '', window.location.pathname);
            }
          })
          .catch(() => {});
      }
    }
  }, []);

  // Cloud sync when authenticated user updates chats, memories, or language
  useEffect(() => {
    if (!authToken || !user) return;
    const timer = setTimeout(() => {
      fetch('/api/user/sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          chats,
          memories,
          preferredLanguage,
        }),
      }).catch(() => {});
    }, 600);
    return () => clearTimeout(timer);
  }, [chats, memories, preferredLanguage, authToken, user]);

  const activeChat = useMemo(
    () => chats.find((c) => c.id === activeChatId) || null,
    [chats, activeChatId]
  );

  // Auto-scroll to latest message
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeChat?.messages.length, isSending]);

  // Auto-resize textarea height
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [input]);

  // Group chats by recency for the left sidebar
  const groupedChats = useMemo(() => {
    const filtered = chats.filter((c) =>
      c.title.toLowerCase().includes(historyFilter.toLowerCase())
    );
    const now = Date.now();
    const oneDay = 1000 * 60 * 60 * 24;
    const sevenDays = oneDay * 7;

    const today: ChatSession[] = [];
    const week: ChatSession[] = [];
    const older: ChatSession[] = [];

    for (const chat of filtered) {
      const updated = new Date(chat.updatedAt).getTime();
      const diff = now - updated;
      if (diff <= oneDay) {
        today.push(chat);
      } else if (diff <= sevenDays) {
        week.push(chat);
      } else {
        older.push(chat);
      }
    }

    return { today, week, older };
  }, [chats, historyFilter]);

  const handleStartNewChat = () => {
    setActiveChatId(null);
    setInput('');
    setImageAttachment(null);
    setErrorBanner(null);
    setMobileSidebarOpen(false);
    setTimeout(() => textareaRef.current?.focus(), 50);
  };

  const handleDeleteChat = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setChats((prev) => prev.filter((c) => c.id !== id));
    if (activeChatId === id) {
      setActiveChatId(null);
    }
    showToast('Conversation deleted');
  };

  const handleSaveRename = (id: string, e: React.FormEvent | React.MouseEvent) => {
    e.stopPropagation();
    const trimmed = editingTitle.trim();
    if (trimmed) {
      setChats((prev) =>
        prev.map((c) => (c.id === id ? { ...c, title: trimmed } : c))
      );
    }
    setEditingChatId(null);
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) {
      setErrorBanner('Please select an image smaller than 8MB.');
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const base64Data = result.split(',')[1];
      if (base64Data) {
        setImageAttachment({
          data: base64Data,
          mimeType: file.type || 'image/png',
          preview: result,
        });
      }
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const stopAnySpeakingAudio = () => {
    speechSessionIdRef.current += 1;
    if (currentAudioRef.current) {
      currentAudioRef.current.pause();
      currentAudioRef.current = null;
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    setSpeakingMsgId(null);
  };

  // Prepares text so every word in Roman Urdu, English, or Urdu is pronounced clearly without markdown clutter
  const prepareClearSpokenText = (rawText: string, applyRomanUrduPhonetics = false): string => {
    let text = rawText
      .replace(/<think>[\s\S]*?<\/think>/gi, ' ')
      .replace(/!\[[^\]]*\]\([^)]+\)/g, ' ')
      .replace(/```[\s\S]*?```/g, '. Code example is shown on screen. ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/^\s*#{1,6}\s+/gm, '. ')
      .replace(/^\s*[-*•]\s+/gm, '. ')
      .replace(/[*_~>|#•·]/g, ' ')
      .replace(/\n+/g, '. ')
      .replace(/\.\s*\./g, '.')
      .replace(/\s+/g, ' ')
      .trim();

    if (applyRomanUrduPhonetics) {
      // Smooth common Roman Urdu words so English TTS voices pronounce them naturally instead of English homographs
      const isRomanUrduContext =
        /\b(hoon|hai|hain|kya|aap|mujhe|tum|batao|samjhao|kaise|mein|main|sakte|chahiye|mera|meri)\b/i.test(
          text
        );
      if (isRomanUrduContext) {
        text = text
          .replace(/\bMain\b/g, 'Mein')
          .replace(/\bmain\b/g, 'mein')
          .replace(/\bhai\b/gi, 'hay')
          .replace(/\bhain\b/gi, 'hein')
          .replace(/\bkya\b/gi, 'kyaa')
          .replace(/\bmujhe\b/gi, 'mujhay')
          .replace(/\bkaise\b/gi, 'kaisay')
          .replace(/\bsakte\b/gi, 'saktay')
          .replace(/\bchahiye\b/gi, 'chaahiye');
      }
    }

    return text;
  };

  const speakTextImmediately = async (msgId: string, textContent: string) => {
    stopAnySpeakingAudio();
    const sessionId = speechSessionIdRef.current;

    const cleanServerText = prepareClearSpokenText(textContent, false).slice(0, 650);
    if (!cleanServerText) return;

    setSpeakingMsgId(msgId);

    // 1. Primary: Studio-Grade Male Voice ('Puck' / 'Charon') from Gemini TTS with valid RIFF WAV header
    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: cleanServerText }),
      });
      if (sessionId !== speechSessionIdRef.current) return;

      const data = await res.json();
      if (res.ok && data.audioBase64 && sessionId === speechSessionIdRef.current) {
        const playedSuccessfully = await new Promise<boolean>((resolve) => {
          const audio = new Audio(`data:audio/wav;base64,${data.audioBase64}`);
          audio.volume = 1.0;
          audio.playbackRate = 1.0;
          currentAudioRef.current = audio;

          audio.onended = () => {
            if (sessionId === speechSessionIdRef.current) {
              setSpeakingMsgId(null);
            }
          };
          audio.onerror = () => {
            resolve(false);
          };

          audio
            .play()
            .then(() => resolve(true))
            .catch(() => resolve(false));
        });

        if (playedSuccessfully) {
          return;
        }
      }
    } catch {
      // Fallback to high-clarity browser Male SpeechSynthesis below
    }

    if (sessionId !== speechSessionIdRef.current) return;

    // 2. Fallback: Crystal-Clear Articulate Male Voice in Browser SpeechSynthesis (Sentence-by-Sentence)
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel();
        const voices =
          availableVoicesRef.current.length > 0
            ? availableVoicesRef.current
            : window.speechSynthesis.getVoices();

        const hasUrduScript = /[\u0600-\u06FF]/.test(textContent);
        const isRomanUrdu =
          /\b(hoon|hai|hain|kya|aap|mujhe|tum|batao|samjhao|kaise|mein|main|sakte|chahiye|mera|meri)\b/i.test(
            textContent
          );

        const excludeFemaleRegex =
          /female|zira|hazel|susan|samantha|victoria|karen|moira|tessa|aria|jenny|sonia|natasha|veena|heera|kalpana/i;

        let selectedVoice: SpeechSynthesisVoice | undefined;

        if (hasUrduScript) {
          selectedVoice =
            voices.find(
              (v) =>
                (v.lang.startsWith('ur') || v.lang.startsWith('hi')) &&
                /male|asad|madhur|prabhat|google/i.test(v.name)
            ) ||
            voices.find((v) => v.lang.startsWith('ur') || v.lang.startsWith('hi'));
        }

        if (!selectedVoice && isRomanUrdu) {
          // South Asian natural male voices pronounce both Roman Urdu & English with 100% clarity
          selectedVoice =
            voices.find(
              (v) =>
                /prabhat|madhur|asad|rishi|ravi|kabir/i.test(v.name) &&
                !excludeFemaleRegex.test(v.name)
            ) ||
            voices.find(
              (v) =>
                (v.lang === 'en-IN' || v.lang === 'hi-IN') &&
                !excludeFemaleRegex.test(v.name)
            );
        }

        if (!selectedVoice) {
          // High-definition Natural Male Voices first
          selectedVoice =
            voices.find(
              (v) =>
                /natural|online|google/i.test(v.name) &&
                /guy|andrew|brian|christopher|ryan|eric|steffan|roger|prabhat|male/i.test(
                  v.name
                )
            ) ||
            voices.find((v) =>
              /google uk english male|daniel|alex|david|mark|james|richard|george|aaron|arthur/i.test(
                v.name
              )
            ) ||
            voices.find(
              (v) => v.lang.startsWith('en') && !excludeFemaleRegex.test(v.name)
            );
        }

        // Apply Roman Urdu phonetic smoothing only if not using Urdu script
        const browserSpokenText = prepareClearSpokenText(
          textContent,
          !hasUrduScript
        ).slice(0, 900);

        // Split into clear sentence chunks so Chrome SpeechSynthesis never cuts off or slurs words
        const rawSentences =
          browserSpokenText.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [browserSpokenText];
        const sentenceQueue: string[] = [];
        for (const s of rawSentences) {
          const trimmed = s.trim();
          if (trimmed) sentenceQueue.push(trimmed);
        }

        if (sentenceQueue.length === 0) {
          setSpeakingMsgId(null);
          return;
        }

        const speakNextSentence = (idx: number) => {
          if (
            sessionId !== speechSessionIdRef.current ||
            idx >= sentenceQueue.length
          ) {
            if (sessionId === speechSessionIdRef.current) {
              setSpeakingMsgId(null);
            }
            return;
          }

          const utterance = new SpeechSynthesisUtterance(sentenceQueue[idx]);
          if (selectedVoice) {
            utterance.voice = selectedVoice;
            utterance.lang = selectedVoice.lang;
          } else {
            utterance.lang = hasUrduScript ? 'ur-PK' : 'en-US';
          }
          // Natural pitch (1.0) and steady articulate rate (0.95) for crystal-clear word pronunciation
          utterance.pitch = 1.0;
          utterance.rate = 0.95;
          utterance.volume = 1.0;

          utterance.onend = () => {
            speakNextSentence(idx + 1);
          };
          utterance.onerror = () => {
            if (sessionId === speechSessionIdRef.current) {
              setSpeakingMsgId(null);
            }
          };

          window.speechSynthesis.speak(utterance);
        };

        speakNextSentence(0);
        return;
      } catch {
        setSpeakingMsgId(null);
      }
    } else {
      setSpeakingMsgId(null);
    }
  };

  // Interactive Logo & Voice Mode Toggle Handler: ONLY speaks when Voice is turned ON
  const handleToggleInteractiveVoice = () => {
    if (speakingMsgId) {
      stopAnySpeakingAudio();
      showToast('Voice playback stopped');
      return;
    }

    const nextVoiceState = !voiceAutoSpeak;
    setVoiceAutoSpeak(nextVoiceState);
    voiceAutoSpeakRef.current = nextVoiceState;
    playLogoFeedbackTone(nextVoiceState);

    if (nextVoiceState) {
      showToast('Voice Reply ON — Clear Male Voice active');
      // If there is a latest assistant reply in the current chat, read it clearly; otherwise speak a brief clear confirmation
      const lastAssistantMsg = activeChat?.messages
        ?.slice()
        .reverse()
        .find((m) => m.role === 'assistant' && m.content.trim().length > 0);

      if (lastAssistantMsg) {
        speakTextImmediately(lastAssistantMsg.id, lastAssistantMsg.content);
      } else {
        speakTextImmediately(
          'logo_voice_greeting',
          'Hello! Toni AI voice reply is now on.'
        );
      }
    } else {
      stopAnySpeakingAudio();
      showToast('Voice Reply OFF — Text replies only');
    }
  };

  const handleSpeakMessage = async (msg: Message) => {
    if (speakingMsgId === msg.id) {
      stopAnySpeakingAudio();
      return;
    }
    await speakTextImmediately(msg.id, msg.content);
  };

  // Universal Microphone Recording + Voice Chat (Works across all browsers via MediaRecorder + Gemini Transcribe & Web Speech)
  const cleanupMicRecording = () => {
    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
    try {
      recognitionRef.current?.stop();
    } catch {}
    recognitionRef.current = null;

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
    mediaRecorderRef.current = null;
    setIsRecordingMic(false);
    setRecordingSeconds(0);
  };

  const startMicrophoneChat = async () => {
    stopAnySpeakingAudio();
    setErrorBanner(null);
    setLiveSpeechDraft('');
    liveSpeechDraftRef.current = '';
    audioChunksRef.current = [];

    // 1. Start Web Speech API in parallel if available for live preview
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SpeechRecognition) {
      try {
        const recognition = new SpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = preferredLanguage === 'Urdu Script' ? 'ur-PK' : 'en-US';
        recognition.onresult = (event: any) => {
          let fullTranscript = '';
          for (let i = 0; i < event.results.length; i++) {
            fullTranscript += event.results[i][0].transcript + ' ';
          }
          const cleaned = fullTranscript.trim();
          if (cleaned) {
            liveSpeechDraftRef.current = cleaned;
            setLiveSpeechDraft(cleaned);
          }
        };
        recognitionRef.current = recognition;
        recognition.start();
      } catch {
        // Ignore if browser SpeechRecognition fails; MediaRecorder below handles it
      }
    }

    // 2. Start standard MediaRecorder for 100% cross-browser microphone capture
    if (navigator?.mediaDevices?.getUserMedia) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaStreamRef.current = stream;

        const recorder = new MediaRecorder(stream);
        mediaRecorderRef.current = recorder;

        recorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) {
            audioChunksRef.current.push(e.data);
          }
        };

        recorder.start();
        setIsRecordingMic(true);
        setRecordingSeconds(0);
        recordingTimerRef.current = setInterval(() => {
          setRecordingSeconds((s) => s + 1);
        }, 1000);
        return;
      } catch (err: any) {
        if (!recognitionRef.current) {
          setErrorBanner(
            'Microphone permission denied. Please allow microphone access in your browser settings.'
          );
          return;
        }
      }
    }

    if (recognitionRef.current) {
      setIsRecordingMic(true);
      setRecordingSeconds(0);
      recordingTimerRef.current = setInterval(() => {
        setRecordingSeconds((s) => s + 1);
      }, 1000);
    } else {
      setErrorBanner('Microphone is not available on this device or browser.');
    }
  };

  const stopAndSendMicrophoneChat = async () => {
    if (!isRecordingMic) return;

    const recorder = mediaRecorderRef.current;
    const immediateDraft = liveSpeechDraftRef.current.trim();

    if (recorder && recorder.state !== 'inactive') {
      setIsTranscribingMic(true);
      await new Promise<void>((resolve) => {
        recorder.onstop = () => resolve();
        recorder.stop();
      });
    }

    cleanupMicRecording();

    // If Web Speech already captured a clear transcript, send it right away for zero-latency voice chat!
    if (immediateDraft.length >= 2) {
      setIsTranscribingMic(false);
      setLiveSpeechDraft('');
      liveSpeechDraftRef.current = '';
      await sendMessage(immediateDraft, true);
      return;
    }

    // Otherwise, send the recorded audio blob to /api/transcribe (Gemini 3.5 Transcribe)
    if (audioChunksRef.current.length > 0) {
      try {
        setIsTranscribingMic(true);
        const audioBlob = new Blob(audioChunksRef.current, {
          type: audioChunksRef.current[0]?.type || 'audio/webm',
        });

        const base64Audio = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => {
            const resStr = String(reader.result || '');
            const b64 = resStr.split(',')[1] || '';
            resolve(b64);
          };
          reader.onerror = reject;
          reader.readAsDataURL(audioBlob);
        });

        if (base64Audio) {
          const res = await fetch('/api/transcribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              audioBase64: base64Audio,
              mimeType: audioBlob.type || 'audio/webm',
              preferredLanguage,
            }),
          });
          const data = await res.json();
          if (res.ok && data.transcript && data.transcript.trim()) {
            setIsTranscribingMic(false);
            setLiveSpeechDraft('');
            await sendMessage(data.transcript.trim(), true);
            return;
          }
        }
      } catch {
        // Fallback below
      } finally {
        setIsTranscribingMic(false);
      }
    }

    setIsTranscribingMic(false);
    setLiveSpeechDraft('');
    showToast('Could not hear clearly. Please tap the mic and speak again.');
  };

  const cancelMicrophoneChat = () => {
    cleanupMicRecording();
    setIsTranscribingMic(false);
    setLiveSpeechDraft('');
    liveSpeechDraftRef.current = '';
  };

  // Ultra-Fast Streaming Send Message Function
  const sendMessage = async (overridePrompt?: string, fromVoiceMic = false) => {
    const textToSend = (overridePrompt !== undefined ? overridePrompt : input).trim();
    if ((!textToSend && !imageAttachment) || isSending) return;

    stopAnySpeakingAudio();
    setErrorBanner(null);
    const attachedImage = imageAttachment;
    setInput('');
    setImageAttachment(null);

    const userMsg: Message = {
      id: 'msg_' + Date.now() + '_u',
      role: 'user',
      content: textToSend || 'Please analyze this image.',
      imagePreview: attachedImage?.preview,
      timestamp: new Date().toISOString(),
    };

    const assistantMsgId = 'msg_' + (Date.now() + 1) + '_a';
    const placeholderAssistantMsg: Message = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      timestamp: new Date().toISOString(),
    };

    let targetChatId = activeChatId;
    let updatedMessagesForApi: Message[] = [];

    if (!targetChatId || !chats.some((c) => c.id === targetChatId)) {
      const newChatId = 'chat_' + Date.now();
      const rawTitle = textToSend || 'Image Analysis';
      const cleanTitle =
        rawTitle.length > 42 ? rawTitle.slice(0, 42) + '...' : rawTitle;
      updatedMessagesForApi = [userMsg];
      const newChat: ChatSession = {
        id: newChatId,
        title: cleanTitle,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: [userMsg, placeholderAssistantMsg],
      };
      targetChatId = newChatId;
      setChats((prev) => [newChat, ...prev]);
      setActiveChatId(newChatId);
    } else {
      const existing = chats.find((c) => c.id === targetChatId)!;
      updatedMessagesForApi = [...existing.messages, userMsg];
      setChats((prev) =>
        prev.map((c) =>
          c.id === targetChatId
            ? {
                ...c,
                updatedAt: new Date().toISOString(),
                messages: [...updatedMessagesForApi, placeholderAssistantMsg],
              }
            : c
        )
      );
    }

    setIsSending(true);

    const parseStreamedText = (raw: string) => {
      let thinking = '';
      let cleanContent = raw;
      const completedThink = raw.match(/<think>([\s\S]*?)<\/think>/i);
      if (completedThink) {
        thinking = completedThink[1].trim();
        cleanContent = raw.replace(/<think>[\s\S]*?<\/think>/i, '').trim();
      } else if (raw.startsWith('<think>')) {
        thinking = raw.replace(/^<think>/i, '').trim();
        cleanContent = '';
      }
      return { thinking, cleanContent };
    };

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (authToken) {
        headers.Authorization = `Bearer ${authToken}`;
      }

      const reqBody = JSON.stringify({
        messages: updatedMessagesForApi.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        memories,
        preferredLanguage,
        deepThink,
        webSearch,
        userName: user?.name || '',
        imageAttachment: attachedImage
          ? { data: attachedImage.data, mimeType: attachedImage.mimeType }
          : null,
      });

      const response = await fetch('/api/chat/stream', {
        method: 'POST',
        headers,
        body: reqBody,
      });

      if (!response.ok || !response.body) {
        throw new Error('Stream unavailable');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let accumulatedText = '';
      let collectedSources: Array<{ title: string; uri: string }> | undefined;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || '';

        for (const block of lines) {
          const dataLine = block
            .split('\n')
            .find((l) => l.startsWith('data: '));
          if (!dataLine) continue;

          try {
            const payload = JSON.parse(dataLine.slice(6));
            if (payload.error) {
              throw new Error(payload.error);
            }
            if (Array.isArray(payload.newMemories) && payload.newMemories.length > 0) {
              setMemories((prev) =>
                Array.from(new Set([...prev, ...payload.newMemories]))
              );
            }
            if (Array.isArray(payload.sources)) {
              collectedSources = payload.sources;
            }
            if (typeof payload.delta === 'string') {
              accumulatedText += payload.delta;
              const { thinking, cleanContent } = parseStreamedText(accumulatedText);

              setChats((prev) =>
                prev.map((c) =>
                  c.id === targetChatId
                    ? {
                        ...c,
                        updatedAt: new Date().toISOString(),
                        messages: c.messages.map((m) =>
                          m.id === assistantMsgId
                            ? {
                                ...m,
                                content: cleanContent,
                                thinking: thinking || undefined,
                                sources: collectedSources,
                              }
                            : m
                        ),
                      }
                    : c
                )
              );
            }
          } catch (innerErr: any) {
            if (innerErr?.message && innerErr.message !== 'Stream unavailable') {
              throw innerErr;
            }
          }
        }
      }

      const finalParsed = parseStreamedText(accumulatedText);
      const finalReply =
        finalParsed.cleanContent ||
        'Main hazir hoon! Please let me know how I can help you.';

      setChats((prev) =>
        prev.map((c) =>
          c.id === targetChatId
            ? {
                ...c,
                updatedAt: new Date().toISOString(),
                messages: c.messages.map((m) =>
                  m.id === assistantMsgId
                    ? {
                        ...m,
                        content: finalReply,
                        thinking: finalParsed.thinking || undefined,
                        sources: collectedSources,
                      }
                    : m
                ),
              }
            : c
        )
      );

      // Speak the reply in clear Male Voice ONLY when Voice Mode (voiceAutoSpeak) is turned ON
      if (voiceAutoSpeakRef.current) {
        speakTextImmediately(assistantMsgId, finalReply);
      }
    } catch (err: any) {
      // Fallback to unary /api/chat if SSE stream encountered an issue
      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        if (authToken) {
          headers.Authorization = `Bearer ${authToken}`;
        }
        const fallbackRes = await fetch('/api/chat', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            messages: updatedMessagesForApi.map((m) => ({
              role: m.role,
              content: m.content,
            })),
            memories,
            preferredLanguage,
            deepThink,
            webSearch,
            userName: user?.name || '',
            imageAttachment: attachedImage
              ? { data: attachedImage.data, mimeType: attachedImage.mimeType }
              : null,
          }),
        });
        const data = await fallbackRes.json();
        if (!fallbackRes.ok) {
          throw new Error(data.error || 'Failed to generate response.');
        }

        setChats((prev) =>
          prev.map((c) =>
            c.id === targetChatId
              ? {
                  ...c,
                  updatedAt: new Date().toISOString(),
                  messages: c.messages.map((m) =>
                    m.id === assistantMsgId
                      ? {
                          ...m,
                          content: data.reply,
                          thinking: data.thinking,
                          sources: data.sources,
                        }
                      : m
                  ),
                }
              : c
          )
        );

        if (voiceAutoSpeakRef.current && data.reply) {
          speakTextImmediately(assistantMsgId, data.reply);
        }
      } catch (finalErr: any) {
        // Remove empty placeholder on error
        setChats((prev) =>
          prev.map((c) =>
            c.id === targetChatId
              ? {
                  ...c,
                  messages: c.messages.filter((m) => m.id !== assistantMsgId),
                }
              : c
          )
        );
        setErrorBanner(
          finalErr?.message ||
            'Connection error while communicating with Toni AI. Please try again.'
        );
      }
    } finally {
      setIsSending(false);
    }
  };

  const handleRegenerateLast = async () => {
    if (!activeChat || activeChat.messages.length === 0 || isSending) return;
    const msgs = [...activeChat.messages];
    if (msgs[msgs.length - 1].role === 'assistant') {
      msgs.pop();
    }
    const lastUser = msgs[msgs.length - 1];
    if (!lastUser || lastUser.role !== 'user') return;

    const priorMessages = msgs.slice(0, -1);
    setChats((prev) =>
      prev.map((c) =>
        c.id === activeChat.id ? { ...c, messages: priorMessages } : c
      )
    );
    await sendMessage(lastUser.content);
  };

  const handleAuthSuccess = (loggedInUser: UserProfile, token: string) => {
    setUser(loggedInUser);
    setAuthToken(token);
    safeStorage.setItem(STORAGE_KEYS.AUTH_TOKEN, token);
    safeStorage.setItem(STORAGE_KEYS.USER_PROFILE, JSON.stringify(loggedInUser));

    if (Array.isArray(loggedInUser.memories) && loggedInUser.memories.length > 0) {
      setMemories((prev) =>
        Array.from(new Set([...prev, ...loggedInUser.memories]))
      );
    }
    const userChats = loggedInUser.chats;
    if (Array.isArray(userChats) && userChats.length > 0) {
      setChats((prev) => {
        const existingIds = new Set(prev.map((c) => c.id));
        const merged = [
          ...prev,
          ...userChats.filter((c: any) => !existingIds.has(c.id)),
        ];
        return merged;
      });
    }
    showToast(`Welcome, ${loggedInUser.name}! Account synced.`);
  };

  const handleLogout = () => {
    setUser(null);
    setAuthToken(null);
    safeStorage.removeItem(STORAGE_KEYS.AUTH_TOKEN);
    safeStorage.removeItem(STORAGE_KEYS.USER_PROFILE);
    showToast('Signed out of account');
  };

  const handleQuickCopyLink = async () => {
    const url = getShareableAppUrl();
    const ok = await copyTextToClipboard(url);
    if (ok) {
      showToast('App link copied! Share it with anyone.');
    }
    setShareModalOpen(true);
  };

  const formatTimer = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  // Shared Black & White Composer Component with Direct Microphone Voice Chat
  const renderComposerBox = (isCenteredHero: boolean) => (
    <div
      className={`w-full transition-all ${
        isCenteredHero ? 'max-w-2xl mx-auto' : 'max-w-3xl mx-auto'
      }`}
    >
      <div
        className={`rounded-2xl border transition-all ${
          isDark
            ? 'bg-[#0D0D0D] border-neutral-800 focus-within:border-white shadow-2xl shadow-black'
            : 'bg-white border-neutral-300 focus-within:border-black shadow-sm'
        }`}
      >
        {/* Active Microphone Voice Recording Bar */}
        {(isRecordingMic || isTranscribingMic) && (
          <div
            className={`px-4 py-3 border-b flex items-center justify-between gap-3 rounded-t-2xl ${
              isDark
                ? 'bg-neutral-900/90 border-neutral-800 text-white'
                : 'bg-neutral-100 border-neutral-200 text-black'
            }`}
          >
            <div className="flex items-center gap-3 min-w-0 flex-1">
              <span
                className={`w-2.5 h-2.5 rounded-full shrink-0 animate-ping ${
                  isDark ? 'bg-white' : 'bg-black'
                }`}
              />
              <div className="min-w-0 flex-1">
                <div className="text-xs font-semibold flex items-center gap-2">
                  <span>
                    {isTranscribingMic
                      ? 'Transcribing your voice...'
                      : 'Microphone Active — Speak in Roman Urdu, Urdu or English'}
                  </span>
                  {!isTranscribingMic && (
                    <span className="font-mono tabular-nums opacity-75">
                      {formatTimer(recordingSeconds)}
                    </span>
                  )}
                </div>
                {liveSpeechDraft && (
                  <p
                    className={`text-xs truncate mt-0.5 italic ${
                      isDark ? 'text-neutral-300' : 'text-neutral-600'
                    }`}
                  >
                    &ldquo;{liveSpeechDraft}&rdquo;
                  </p>
                )}
              </div>
            </div>

            {!isTranscribingMic && (
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={cancelMicrophoneChat}
                  className={`px-2.5 py-1.5 rounded-lg border text-xs font-medium cursor-pointer transition-colors ${
                    isDark
                      ? 'border-neutral-700 hover:bg-neutral-800 text-neutral-300'
                      : 'border-neutral-300 hover:bg-white text-neutral-700'
                  }`}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={stopAndSendMicrophoneChat}
                  className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition-colors ${
                    isDark
                      ? 'bg-white text-black hover:bg-neutral-200'
                      : 'bg-black text-white hover:bg-neutral-800'
                  }`}
                >
                  <Square className="w-3 h-3 fill-current" />
                  <span>Send Voice</span>
                </button>
              </div>
            )}
          </div>
        )}

        {/* Optional Image Attachment Preview */}
        {imageAttachment && (
          <div className="px-4 pt-3 flex items-center gap-3">
            <div className="relative inline-block">
              <img
                src={imageAttachment.preview}
                alt="Attached upload"
                referrerPolicy="no-referrer"
                className="h-14 w-14 object-cover rounded-xl border border-neutral-700"
              />
              <button
                type="button"
                onClick={() => setImageAttachment(null)}
                className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-black text-white flex items-center justify-center border border-neutral-600 cursor-pointer"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
            <span
              className={`text-xs ${
                isDark ? 'text-neutral-400' : 'text-neutral-500'
              }`}
            >
              Image attached for Toni AI analysis
            </span>
          </div>
        )}

        {/* Auto-expanding Textarea */}
        <div className="px-4 pt-3.5 pb-2">
          <textarea
            ref={textareaRef}
            rows={isCenteredHero ? 3 : 1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
              }
            }}
            placeholder="Message Toni AI or tap Mic to talk... (Roman Urdu, English, اردو)"
            className={`w-full resize-none bg-transparent text-[15px] leading-relaxed outline-none ${
              isDark
                ? 'text-white placeholder:text-neutral-500'
                : 'text-black placeholder:text-neutral-400'
            }`}
          />
        </div>

        {/* DeepSeek-style Minimal Bottom Control Row inside Composer */}
        <div className="flex items-center justify-between px-3.5 pb-3 pt-1 gap-2">
          {/* Left: Quick / DeepThink, Web Search, and Image Attachment */}
          <div className="flex items-center gap-1.5 sm:gap-2">
            <button
              type="button"
              onClick={() => setDeepThink((prev) => !prev)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium border transition-colors cursor-pointer whitespace-nowrap ${
                deepThink
                  ? isDark
                    ? 'bg-white text-black border-white font-semibold'
                    : 'bg-black text-white border-black font-semibold'
                  : isDark
                  ? 'bg-neutral-900 border-neutral-800 text-neutral-400 hover:text-white'
                  : 'bg-neutral-100 border-neutral-200 text-neutral-600 hover:text-black'
              }`}
              title={
                deepThink
                  ? 'DeepThink Reasoning ON (Click for Quick Response Mode)'
                  : 'Quick Response Mode ON (Click to enable DeepThink)'
              }
            >
              {deepThink ? (
                <>
                  <Cpu className="w-3.5 h-3.5" />
                  <span>DeepThink</span>
                </>
              ) : (
                <>
                  <Zap className="w-3.5 h-3.5" />
                  <span>Quick Mode</span>
                </>
              )}
            </button>

            <button
              type="button"
              onClick={() => setWebSearch((prev) => !prev)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium border transition-colors cursor-pointer whitespace-nowrap ${
                webSearch
                  ? isDark
                    ? 'bg-white text-black border-white font-semibold'
                    : 'bg-black text-white border-black font-semibold'
                  : isDark
                  ? 'bg-neutral-900 border-neutral-800 text-neutral-400 hover:text-white'
                  : 'bg-neutral-100 border-neutral-200 text-neutral-600 hover:text-black'
              }`}
              title="Search live web information with Google Search"
            >
              <Globe className="w-3.5 h-3.5" />
              <span>Search</span>
            </button>

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleImageUpload}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className={`p-1.5 rounded-xl border transition-colors cursor-pointer ${
                isDark
                  ? 'border-transparent text-neutral-400 hover:text-white hover:bg-neutral-900'
                  : 'border-transparent text-neutral-500 hover:text-black hover:bg-neutral-100'
              }`}
              title="Attach image"
            >
              <Paperclip className="w-4 h-4" />
            </button>
          </div>

          {/* Right: Voice Reply ON/OFF Toggle, Microphone Voice Chat & Send Button */}
          <div className="flex items-center gap-1.5 sm:gap-2">
            <button
              type="button"
              onClick={handleToggleInteractiveVoice}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-semibold border transition-all cursor-pointer whitespace-nowrap ${
                voiceAutoSpeak || speakingMsgId
                  ? isDark
                    ? 'bg-white text-black border-white'
                    : 'bg-black text-white border-black'
                  : isDark
                  ? 'bg-neutral-900 border-neutral-800 text-neutral-400 hover:text-white'
                  : 'bg-neutral-100 border-neutral-300 text-neutral-600 hover:text-black'
              }`}
              title={
                speakingMsgId
                  ? 'Speaking now — Click to stop voice'
                  : voiceAutoSpeak
                  ? 'Voice Reply is ON (Replies in clear Male Voice) — Click to turn OFF'
                  : 'Voice Reply is OFF — Turn ON to hear voice replies'
              }
            >
              {voiceAutoSpeak || speakingMsgId ? (
                <>
                  <Volume2 className="w-3.5 h-3.5" />
                  <span>{speakingMsgId ? 'Speaking...' : 'Voice ON'}</span>
                </>
              ) : (
                <>
                  <VolumeX className="w-3.5 h-3.5 opacity-70" />
                  <span>Voice OFF</span>
                </>
              )}
            </button>

            <button
              type="button"
              onClick={() => {
                if (isRecordingMic) {
                  stopAndSendMicrophoneChat();
                } else {
                  startMicrophoneChat();
                }
              }}
              disabled={isTranscribingMic || isSending}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border transition-all cursor-pointer whitespace-nowrap ${
                isRecordingMic
                  ? isDark
                    ? 'bg-white text-black border-white animate-pulse'
                    : 'bg-black text-white border-black animate-pulse'
                  : isDark
                  ? 'bg-neutral-900 border-neutral-800 text-neutral-200 hover:border-neutral-600 hover:bg-neutral-800'
                  : 'bg-neutral-100 border-neutral-300 text-neutral-800 hover:border-neutral-400 hover:bg-neutral-200'
              }`}
              title={
                isRecordingMic
                  ? 'Click to stop and send voice message'
                  : 'Chat with Microphone (Voice Chat)'
              }
            >
              <Mic className="w-3.5 h-3.5" />
              <span>{isRecordingMic ? 'Send Voice' : 'Mic Chat'}</span>
            </button>

            <button
              type="button"
              onClick={() => sendMessage()}
              disabled={(!input.trim() && !imageAttachment) || isSending}
              className={`w-8 h-8 rounded-xl flex items-center justify-center transition-colors cursor-pointer ${
                (!input.trim() && !imageAttachment) || isSending
                  ? isDark
                    ? 'bg-neutral-900 text-neutral-600 cursor-not-allowed'
                    : 'bg-neutral-200 text-neutral-400 cursor-not-allowed'
                  : isDark
                  ? 'bg-white hover:bg-neutral-200 text-black'
                  : 'bg-black hover:bg-neutral-800 text-white'
              }`}
              title="Send message"
            >
              <ArrowUp className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  const renderChatListSection = (label: string, items: ChatSession[]) => {
    if (items.length === 0) return null;
    return (
      <div className="mb-4">
        <div
          className={`px-3 mb-1.5 text-[11px] font-medium ${
            isDark ? 'text-neutral-500' : 'text-neutral-400'
          }`}
        >
          {label}
        </div>
        <div className="space-y-0.5">
          {items.map((chat) => {
            const isActive = chat.id === activeChatId;
            const isEditing = editingChatId === chat.id;

            return (
              <div
                key={chat.id}
                onClick={() => {
                  setActiveChatId(chat.id);
                  setMobileSidebarOpen(false);
                }}
                className={`group flex items-center justify-between gap-2 px-3 py-2 rounded-xl text-xs font-medium cursor-pointer transition-colors ${
                  isActive
                    ? isDark
                      ? 'bg-white text-black font-semibold'
                      : 'bg-black text-white font-semibold'
                    : isDark
                    ? 'text-neutral-300 hover:bg-neutral-900 hover:text-white'
                    : 'text-neutral-700 hover:bg-neutral-200/70 hover:text-black'
                }`}
              >
                <div className="flex items-center gap-2.5 min-w-0 flex-1">
                  <MessageSquare
                    className={`w-3.5 h-3.5 shrink-0 ${
                      isActive ? 'opacity-100' : 'opacity-60'
                    }`}
                  />
                  {isEditing ? (
                    <input
                      type="text"
                      autoFocus
                      value={editingTitle}
                      onChange={(e) => setEditingTitle(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleSaveRename(chat.id, e);
                        if (e.key === 'Escape') setEditingChatId(null);
                      }}
                      className={`w-full px-1.5 py-0.5 rounded text-xs outline-none border ${
                        isDark
                          ? 'bg-black border-white text-white'
                          : 'bg-white border-black text-black'
                      }`}
                    />
                  ) : (
                    <span className="truncate">{chat.title}</span>
                  )}
                </div>

                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                  {isEditing ? (
                    <button
                      type="button"
                      onClick={(e) => handleSaveRename(chat.id, e)}
                      className="p-1"
                    >
                      <Check className="w-3.5 h-3.5" />
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingChatId(chat.id);
                          setEditingTitle(chat.title);
                        }}
                        className="p-1 opacity-70 hover:opacity-100"
                        title="Rename chat"
                      >
                        <Edit3 className="w-3 h-3" />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => handleDeleteChat(chat.id, e)}
                        className="p-1 opacity-70 hover:opacity-100"
                        title="Delete chat"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  const sidebarContent = (
    <div
      className={`flex flex-col h-full w-[268px] select-none border-r transition-colors ${
        isDark
          ? 'bg-[#070707] border-neutral-800 text-neutral-200'
          : 'bg-[#F5F5F5] border-neutral-200 text-neutral-800'
      }`}
    >
      {/* Sidebar Top: Interactive Brand Logo & Collapse */}
      <div className="flex items-center justify-between px-4 pt-4 pb-3">
        <div className="flex items-center gap-2.5">
          <InteractiveLogo
            isDark={isDark}
            variant="sidebar"
            voiceEnabled={voiceAutoSpeak}
            isSpeaking={Boolean(speakingMsgId)}
            isListening={isRecordingMic}
            isThinking={isSending}
            onClick={handleToggleInteractiveVoice}
            title={
              voiceAutoSpeak
                ? 'Interactive Toni AI Logo — Voice Reply is ON (Click to turn OFF)'
                : 'Interactive Toni AI Logo — Click to turn Voice Reply ON'
            }
          />
          <span
            onClick={handleStartNewChat}
            className={`font-bold text-base tracking-tight cursor-pointer ${
              isDark ? 'text-white' : 'text-black'
            }`}
          >
            Toni AI
          </span>
        </div>

        <button
          type="button"
          onClick={() => {
            setSidebarOpen(false);
            setMobileSidebarOpen(false);
          }}
          className={`p-1.5 rounded-lg transition-colors cursor-pointer ${
            isDark
              ? 'text-neutral-400 hover:text-white hover:bg-neutral-900'
              : 'text-neutral-500 hover:text-black hover:bg-neutral-200'
          }`}
          title="Collapse sidebar"
        >
          <PanelLeftClose className="w-4 h-4" />
        </button>
      </div>

      {/* Primary New Chat Button (Black & White High Contrast) */}
      <div className="px-3 mb-3">
        <button
          type="button"
          onClick={handleStartNewChat}
          className={`w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl text-xs font-semibold border transition-all cursor-pointer ${
            isDark
              ? 'bg-white hover:bg-neutral-200 border-white text-black'
              : 'bg-black hover:bg-neutral-800 border-black text-white'
          }`}
        >
          <Plus className="w-4 h-4" />
          <span>New chat</span>
        </button>
      </div>

      {/* Optional History Filter if > 2 chats */}
      {chats.length > 2 && (
        <div className="px-3 mb-2">
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
            <input
              type="text"
              value={historyFilter}
              onChange={(e) => setHistoryFilter(e.target.value)}
              placeholder="Search chat history..."
              className={`w-full pl-8 pr-3 py-1.5 rounded-lg text-xs border outline-none ${
                isDark
                  ? 'bg-black border-neutral-800 text-white focus:border-neutral-600'
                  : 'bg-white border-neutral-300 text-black focus:border-neutral-500'
              }`}
            />
          </div>
        </div>
      )}

      {/* Scrollable Chat History */}
      <div className="flex-1 overflow-y-auto px-2 py-1">
        {chats.length === 0 ? (
          <div
            className={`px-3 py-8 text-center text-xs ${
              isDark ? 'text-neutral-500' : 'text-neutral-400'
            }`}
          >
            No chat history yet. Ask Toni AI any question or tap Mic Chat.
          </div>
        ) : (
          <>
            {renderChatListSection('Today', groupedChats.today)}
            {renderChatListSection('Previous 7 Days', groupedChats.week)}
            {renderChatListSection('Earlier', groupedChats.older)}
          </>
        )}
      </div>

      {/* Left Sidebar Bottom Options: Memory, Voice Reply, Language, Theme, Sign In / Login */}
      <div
        className={`p-3 border-t space-y-1.5 ${
          isDark ? 'border-neutral-800' : 'border-neutral-200'
        }`}
      >
        {/* Long-Term Memory Option */}
        <button
          type="button"
          onClick={() => setMemoryModalOpen(true)}
          className={`w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs font-medium transition-colors cursor-pointer ${
            isDark
              ? 'text-neutral-300 hover:bg-neutral-900 hover:text-white'
              : 'text-neutral-700 hover:bg-neutral-200/70 hover:text-black'
          }`}
        >
          <span className="flex items-center gap-2.5">
            <Brain className="w-4 h-4" />
            <span>Memory Bank</span>
          </span>
          <span
            className={`font-mono tabular-nums text-[11px] ${
              isDark ? 'text-neutral-400' : 'text-neutral-500'
            }`}
          >
            {memories.length} saved
          </span>
        </button>

        {/* Voice Reply Toggle (Only speaks when turned ON) */}
        <button
          type="button"
          onClick={handleToggleInteractiveVoice}
          className={`w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs font-medium transition-colors cursor-pointer ${
            voiceAutoSpeak
              ? isDark
                ? 'bg-white text-black font-semibold'
                : 'bg-black text-white font-semibold'
              : isDark
              ? 'text-neutral-300 hover:bg-neutral-900 hover:text-white'
              : 'text-neutral-700 hover:bg-neutral-200/70 hover:text-black'
          }`}
        >
          <span className="flex items-center gap-2.5">
            {voiceAutoSpeak ? (
              <Volume2 className="w-4 h-4" />
            ) : (
              <VolumeX className="w-4 h-4 opacity-60" />
            )}
            <span>Voice Reply</span>
          </span>
          <span
            className={`text-[11px] font-mono ${
              voiceAutoSpeak
                ? 'opacity-90'
                : isDark
                ? 'text-neutral-400'
                : 'text-neutral-500'
            }`}
          >
            {voiceAutoSpeak ? 'ON' : 'OFF'}
          </span>
        </button>

        {/* Language Mode Selector */}
        <div
          className={`flex items-center justify-between px-3 py-1.5 rounded-xl text-xs ${
            isDark ? 'text-neutral-300' : 'text-neutral-700'
          }`}
        >
          <span className="flex items-center gap-2.5 shrink-0">
            <Globe className="w-4 h-4" />
            <span>Language</span>
          </span>
          <select
            value={preferredLanguage}
            onChange={(e) => setPreferredLanguage(e.target.value as LanguageMode)}
            className={`text-xs font-medium rounded-lg px-2 py-1 outline-none cursor-pointer max-w-[130px] truncate ${
              isDark
                ? 'bg-black text-white border border-neutral-800'
                : 'bg-white text-black border border-neutral-300'
            }`}
          >
            <option value="Auto (Roman Urdu & All Languages)">
              Auto (Roman Urdu)
            </option>
            <option value="Roman Urdu">Roman Urdu Only</option>
            <option value="English">English</option>
            <option value="Urdu Script">اردو (Urdu Script)</option>
          </select>
        </div>

        {/* Black / White Theme Toggle */}
        <button
          type="button"
          onClick={() => setIsDark((prev) => !prev)}
          className={`w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs font-medium transition-colors cursor-pointer ${
            isDark
              ? 'text-neutral-300 hover:bg-neutral-900 hover:text-white'
              : 'text-neutral-700 hover:bg-neutral-200/70 hover:text-black'
          }`}
        >
          <span className="flex items-center gap-2.5">
            {isDark ? (
              <Sun className="w-4 h-4" />
            ) : (
              <Moon className="w-4 h-4" />
            )}
            <span>{isDark ? 'White Theme (Light)' : 'Black Theme (Dark)'}</span>
          </span>
          <span
            className={`text-[11px] ${
              isDark ? 'text-neutral-500' : 'text-neutral-500'
            }`}
          >
            {isDark ? 'Black' : 'White'}
          </span>
        </button>

        {/* Sign In / Login / User Profile Card */}
        <button
          type="button"
          onClick={() => setAuthModalOpen(true)}
          className={`w-full flex items-center justify-between gap-2.5 p-2.5 rounded-xl border text-left transition-colors cursor-pointer ${
            isDark
              ? 'bg-black border-neutral-800 hover:border-neutral-600'
              : 'bg-white border-neutral-300 hover:border-neutral-500'
          }`}
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <div
              className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
                isDark ? 'bg-white text-black' : 'bg-black text-white'
              }`}
            >
              {user ? (
                user.name.slice(0, 2).toUpperCase()
              ) : (
                <LogIn className="w-4 h-4" />
              )}
            </div>
            <div className="min-w-0">
              <div className="text-xs font-semibold truncate flex items-center gap-1">
                <span>{user ? user.name : 'Sign In / Login'}</span>
                {user && <ShieldCheck className="w-3.5 h-3.5" />}
              </div>
              <div
                className={`text-[11px] truncate ${
                  isDark ? 'text-neutral-400' : 'text-neutral-500'
                }`}
              >
                {user ? user.email : 'Secure account & history sync'}
              </div>
            </div>
          </div>
          {user && <UserCheck className="w-4 h-4 shrink-0" />}
        </button>

        {/* Quiet Developer Attribution Footer */}
        <div
          className={`pt-1 px-2 flex items-center justify-between text-[11px] ${
            isDark ? 'text-neutral-500' : 'text-neutral-500'
          }`}
        >
          <span>Developed by Zain Shoaib</span>
          <button
            type="button"
            onClick={() => setShareModalOpen(true)}
            className={`underline underline-offset-2 cursor-pointer ${
              isDark ? 'hover:text-white' : 'hover:text-black'
            }`}
          >
            Share App
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div
      className={`flex h-screen w-screen overflow-hidden ${
        isDark ? 'bg-black text-white' : 'bg-white text-black'
      }`}
    >
      {/* Desktop Collapsible Left Sidebar */}
      {sidebarOpen && <aside className="hidden md:block h-full">{sidebarContent}</aside>}

      {/* Mobile Drawer Overlay */}
      {mobileSidebarOpen && (
        <div className="fixed inset-0 z-40 flex md:hidden">
          <div
            className="fixed inset-0 bg-black/75 backdrop-blur-xs"
            onClick={() => setMobileSidebarOpen(false)}
          />
          <div className="relative z-50 h-full">{sidebarContent}</div>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 h-full relative">
        {/* Top Bar Contract: 3 Clean Zones */}
        <header
          className={`h-14 px-4 sm:px-6 flex items-center justify-between border-b shrink-0 ${
            isDark
              ? 'bg-black border-neutral-800'
              : 'bg-white border-neutral-200'
          }`}
        >
          {/* Zone 1: Sidebar Trigger, Interactive Logo & Brand/Title */}
          <div className="flex items-center gap-2.5 min-w-0">
            <button
              type="button"
              onClick={() => {
                if (window.innerWidth < 768) {
                  setMobileSidebarOpen(true);
                } else {
                  setSidebarOpen((prev) => !prev);
                }
              }}
              className={`p-2 rounded-lg transition-colors cursor-pointer ${
                isDark
                  ? 'text-neutral-400 hover:text-white hover:bg-neutral-900'
                  : 'text-neutral-500 hover:text-black hover:bg-neutral-100'
              }`}
              title="Toggle sidebar"
            >
              <PanelLeft className="w-4 h-4" />
            </button>
            <InteractiveLogo
              isDark={isDark}
              variant="sidebar"
              voiceEnabled={voiceAutoSpeak}
              isSpeaking={Boolean(speakingMsgId)}
              isListening={isRecordingMic}
              isThinking={isSending}
              onClick={handleToggleInteractiveVoice}
              title={
                voiceAutoSpeak
                  ? 'Interactive Logo — Voice Reply ON (Click to turn OFF)'
                  : 'Interactive Logo — Voice Reply OFF (Click to turn ON)'
              }
            />
            <span className="font-semibold text-sm sm:text-base tracking-tight truncate">
              {activeChat ? activeChat.title : 'Toni AI'}
            </span>
          </div>

          {/* Zone 2: Clean Unboxed Metadata */}
          <div
            className={`hidden lg:flex items-center gap-2 text-xs ${
              isDark ? 'text-neutral-400' : 'text-neutral-500'
            }`}
          >
            <span>By Zain Shoaib</span>
            <span aria-hidden="true">·</span>
            <span>Quick Streaming</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums">
              Memory ({memories.length})
            </span>
          </div>

          {/* Zone 3: Primary Action (Share App Link) */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleQuickCopyLink}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border transition-colors cursor-pointer whitespace-nowrap ${
                isDark
                  ? 'bg-white text-black border-white hover:bg-neutral-200'
                  : 'bg-black text-white border-black hover:bg-neutral-800'
              }`}
            >
              <Share2 className="w-3.5 h-3.5" />
              <span>Share App Link</span>
            </button>
          </div>
        </header>

        {/* Toast Notification */}
        {toastMessage && (
          <div
            className={`fixed top-16 right-6 z-50 px-4 py-2.5 rounded-xl text-xs font-semibold shadow-xl flex items-center gap-2 border ${
              isDark
                ? 'bg-white text-black border-neutral-200'
                : 'bg-black text-white border-neutral-800'
            }`}
          >
            <Check className="w-3.5 h-3.5" />
            <span>{toastMessage}</span>
          </div>
        )}

        {/* Main Viewport: DeepSeek-style Centered Empty State OR Active Conversation Stream */}
        {!activeChat || activeChat.messages.length === 0 ? (
          <main className="flex-1 overflow-y-auto px-4 sm:px-6 flex flex-col items-center justify-center">
            <div className="w-full max-w-2xl mx-auto text-center mb-6">
              <InteractiveLogo
                isDark={isDark}
                variant="hero"
                voiceEnabled={voiceAutoSpeak}
                isSpeaking={Boolean(speakingMsgId)}
                isListening={isRecordingMic}
                isThinking={isSending}
                onClick={handleToggleInteractiveVoice}
              />
              <h1
                className="text-2xl sm:text-3xl font-bold tracking-tight mb-2"
                style={{ textWrap: 'balance' }}
              >
                Hello, I&apos;m Toni AI.
              </h1>
              <p
                className={`text-xs sm:text-sm ${
                  isDark ? 'text-neutral-400' : 'text-neutral-600'
                }`}
              >
                Developed by <strong>Zain Shoaib</strong> · Instant Responses · Clear Male Voice · Roman Urdu &amp; All Languages
              </p>
            </div>

            {errorBanner && (
              <div
                className={`w-full max-w-2xl mb-4 p-3.5 rounded-xl border text-xs flex items-center justify-between ${
                  isDark
                    ? 'bg-neutral-900 border-neutral-700 text-neutral-200'
                    : 'bg-neutral-100 border-neutral-300 text-neutral-800'
                }`}
              >
                <span>{errorBanner}</span>
                <button
                  type="button"
                  onClick={() => setErrorBanner(null)}
                  className="p-1"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            {/* Centered DeepSeek Composer */}
            {renderComposerBox(true)}

            {/* 4 Clean Starter Prompts */}
            <div className="w-full max-w-2xl mx-auto mt-6 grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {STARTER_PROMPTS.map((item, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => sendMessage(item.prompt)}
                  className={`text-left p-3.5 rounded-xl border transition-colors cursor-pointer ${
                    isDark
                      ? 'bg-[#0A0A0A] border-neutral-800 hover:border-neutral-600 hover:bg-neutral-900'
                      : 'bg-white border-neutral-200 hover:border-neutral-400 hover:bg-neutral-50'
                  }`}
                >
                  <div className="text-xs font-semibold mb-1">{item.title}</div>
                  <p
                    className={`text-xs line-clamp-2 leading-relaxed ${
                      isDark ? 'text-neutral-400' : 'text-neutral-600'
                    }`}
                  >
                    {item.prompt}
                  </p>
                  <div
                    className={`mt-2 text-[11px] ${
                      isDark ? 'text-neutral-500' : 'text-neutral-400'
                    }`}
                  >
                    {item.meta}
                  </div>
                </button>
              ))}
            </div>
          </main>
        ) : (
          <>
            {/* Active Message Stream */}
            <main className="flex-1 overflow-y-auto px-4 sm:px-6 py-6">
              <div className="max-w-3xl mx-auto space-y-6">
                {activeChat.messages.map((msg) => {
                  const isUser = msg.role === 'user';
                  const isThinkingCollapsed = !!collapsedThinking[msg.id];

                  if (isUser) {
                    return (
                      <div key={msg.id} className="flex justify-end">
                        <div
                          className={`max-w-[85%] sm:max-w-[78%] rounded-2xl px-4 py-3 text-[15px] leading-relaxed ${
                            isDark
                              ? 'bg-white text-black font-medium'
                              : 'bg-black text-white font-medium'
                          }`}
                        >
                          {msg.imagePreview && (
                            <img
                              src={msg.imagePreview}
                              alt="Uploaded attachment"
                              referrerPolicy="no-referrer"
                              className="max-h-48 rounded-xl mb-2.5 object-contain border border-neutral-500/30"
                            />
                          )}
                          <div className="whitespace-pre-wrap break-words">
                            {msg.content}
                          </div>
                        </div>
                      </div>
                    );
                  }

                  return (
                    <div key={msg.id} className="flex items-start gap-3.5">
                      <div className="mt-0.5 shrink-0">
                        <InteractiveLogo
                          isDark={isDark}
                          variant="avatar"
                          voiceEnabled={voiceAutoSpeak}
                          isSpeaking={speakingMsgId === msg.id}
                          isListening={false}
                          isThinking={isSending && !msg.content}
                          onClick={() => handleSpeakMessage(msg)}
                          title={
                            speakingMsgId === msg.id
                              ? 'Click to stop speaking this message'
                              : 'Click to hear this response in clear Male Voice'
                          }
                        />
                      </div>

                      <div className="flex-1 min-w-0 space-y-2.5">
                        <div className="flex items-center gap-2 text-xs">
                          <span className="font-semibold">Toni AI</span>
                          <span
                            className={
                              isDark ? 'text-neutral-500' : 'text-neutral-400'
                            }
                          >
                            · By Zain Shoaib
                          </span>
                        </div>

                        {/* DeepThink Collapsible Reasoning Block */}
                        {msg.thinking && (
                          <div
                            className={`rounded-xl border overflow-hidden ${
                              isDark
                                ? 'bg-[#0A0A0A] border-neutral-800 text-neutral-300'
                                : 'bg-neutral-100 border-neutral-200 text-neutral-700'
                            }`}
                          >
                            <button
                              type="button"
                              onClick={() =>
                                setCollapsedThinking((prev) => ({
                                  ...prev,
                                  [msg.id]: !prev[msg.id],
                                }))
                              }
                              className="w-full flex items-center justify-between px-3.5 py-2 text-xs font-medium cursor-pointer"
                            >
                              <span className="flex items-center gap-1.5">
                                <Cpu className="w-3.5 h-3.5" />
                                <span>Thought process (DeepThink)</span>
                              </span>
                              {isThinkingCollapsed ? (
                                <ChevronRight className="w-3.5 h-3.5" />
                              ) : (
                                <ChevronDown className="w-3.5 h-3.5" />
                              )}
                            </button>
                            {!isThinkingCollapsed && (
                              <div
                                className={`px-3.5 pb-3 pt-1 text-xs leading-relaxed border-t whitespace-pre-wrap ${
                                  isDark
                                    ? 'border-neutral-800 text-neutral-400'
                                    : 'border-neutral-200 text-neutral-600'
                                }`}
                              >
                                {msg.thinking}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Main Formatted Response (or Quick Streaming Cursor) */}
                        {msg.content ? (
                          <MarkdownRenderer content={msg.content} isDark={isDark} />
                        ) : (
                          <div className="flex items-center gap-2 py-1 text-xs opacity-70">
                            <span
                              className={`w-2 h-2 rounded-full animate-ping ${
                                isDark ? 'bg-white' : 'bg-black'
                              }`}
                            />
                            <span>Responding...</span>
                          </div>
                        )}

                        {/* Verified Web Search Sources */}
                        {msg.sources && msg.sources.length > 0 && (
                          <div
                            className={`pt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs ${
                              isDark ? 'text-neutral-400' : 'text-neutral-600'
                            }`}
                          >
                            <span className="font-medium">Sources:</span>
                            {msg.sources.map((src, sIdx) => (
                              <a
                                key={sIdx}
                                href={src.uri}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 underline hover:opacity-80"
                              >
                                <span className="truncate max-w-[180px]">
                                  {src.title}
                                </span>
                                <ExternalLink className="w-3 h-3 shrink-0" />
                              </a>
                            ))}
                          </div>
                        )}

                        {/* Quiet Message Action Bar */}
                        {msg.content && (
                          <div
                            className={`flex items-center gap-3 pt-1 text-xs ${
                              isDark ? 'text-neutral-500' : 'text-neutral-500'
                            }`}
                          >
                            <button
                              type="button"
                              onClick={async () => {
                                await copyTextToClipboard(msg.content);
                                setCopiedMsgId(msg.id);
                                setTimeout(() => setCopiedMsgId(null), 1800);
                              }}
                              className={`inline-flex items-center gap-1 transition-colors cursor-pointer ${
                                isDark ? 'hover:text-white' : 'hover:text-black'
                              }`}
                              title="Copy response"
                            >
                              {copiedMsgId === msg.id ? (
                                <>
                                  <Check className="w-3.5 h-3.5" />
                                  <span>Copied</span>
                                </>
                              ) : (
                                <>
                                  <Copy className="w-3.5 h-3.5" />
                                  <span>Copy</span>
                                </>
                              )}
                            </button>

                            <button
                              type="button"
                              onClick={() => handleSpeakMessage(msg)}
                              className={`inline-flex items-center gap-1 transition-colors cursor-pointer ${
                                isDark ? 'hover:text-white' : 'hover:text-black'
                              }`}
                              title="Listen to response"
                            >
                              {speakingMsgId === msg.id ? (
                                <>
                                  <VolumeX className="w-3.5 h-3.5" />
                                  <span className="font-semibold">Stop Audio</span>
                                </>
                              ) : (
                                <>
                                  <Volume2 className="w-3.5 h-3.5" />
                                  <span>Listen</span>
                                </>
                              )}
                            </button>

                            <button
                              type="button"
                              onClick={handleRegenerateLast}
                              className={`inline-flex items-center gap-1 transition-colors cursor-pointer ${
                                isDark ? 'hover:text-white' : 'hover:text-black'
                              }`}
                              title="Regenerate response"
                            >
                              <RotateCcw className="w-3.5 h-3.5" />
                              <span>Regenerate</span>
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}

                {errorBanner && (
                  <div
                    className={`p-3.5 rounded-xl border text-xs flex items-center justify-between ${
                      isDark
                        ? 'bg-neutral-900 border-neutral-700 text-neutral-200'
                        : 'bg-neutral-100 border-neutral-300 text-neutral-800'
                    }`}
                  >
                    <span>{errorBanner}</span>
                    <button
                      type="button"
                      onClick={handleRegenerateLast}
                      className={`px-2.5 py-1 rounded-lg font-semibold cursor-pointer ${
                        isDark
                          ? 'bg-white text-black'
                          : 'bg-black text-white'
                      }`}
                    >
                      Retry
                    </button>
                  </div>
                )}

                <div ref={messagesEndRef} />
              </div>
            </main>

            {/* Bottom Docked Composer */}
            <footer className="px-4 sm:px-6 pb-4 pt-2 shrink-0">
              {renderComposerBox(false)}
              <div
                className={`text-center text-[11px] mt-2 ${
                  isDark ? 'text-neutral-500' : 'text-neutral-400'
                }`}
              >
                Toni AI · Developed by Zain Shoaib · Quick Response &amp; Microphone Voice Chat
              </div>
            </footer>
          </>
        )}
      </div>

      {/* Modals */}
      <AuthModal
        isOpen={authModalOpen}
        onClose={() => setAuthModalOpen(false)}
        isDark={isDark}
        user={user}
        onAuthSuccess={handleAuthSuccess}
        onLogout={handleLogout}
        chats={chats}
        memories={memories}
        preferredLanguage={preferredLanguage}
      />

      <MemoryModal
        isOpen={memoryModalOpen}
        onClose={() => setMemoryModalOpen(false)}
        isDark={isDark}
        memories={memories}
        onAddMemory={(fact) => {
          setMemories((prev) => Array.from(new Set([...prev, fact])));
          showToast('Memory added');
        }}
        onRemoveMemory={(index) => {
          setMemories((prev) => prev.filter((_, i) => i !== index));
        }}
        onClearMemories={() => {
          setMemories([]);
          showToast('All memories cleared');
        }}
      />

      <ShareModal
        isOpen={shareModalOpen}
        onClose={() => setShareModalOpen(false)}
        isDark={isDark}
        activeChat={activeChat}
        userName={user?.name}
      />
    </div>
  );
}
