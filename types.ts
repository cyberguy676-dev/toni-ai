export type LanguageMode =
  | 'Auto (Roman Urdu & All Languages)'
  | 'Roman Urdu'
  | 'English'
  | 'Urdu Script';

export interface WebSource {
  title: string;
  uri: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  thinking?: string;
  sources?: WebSource[];
  imagePreview?: string;
  timestamp: string;
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
}

export interface UserProfile {
  id: string;
  name: string;
  email: string;
  createdAt: string;
  preferredLanguage: LanguageMode;
  memories: string[];
  chats?: ChatSession[];
}
