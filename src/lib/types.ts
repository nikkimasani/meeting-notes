export type Segment = {
  id: string;
  speaker: string; // speaker id, e.g. "S1"
  text: string;
  start: number; // seconds from meeting start
  end: number;
  highlight?: boolean;
  comment?: string;
};

export type OutlineSection = { heading: string; start: number; bullets: string[] };

export type ActionItem = {
  id: string;
  task: string;
  owner: string | null;
  due: string | null;
  start: number | null;
  done: boolean;
};

export type ChatMessage = { role: "user" | "assistant"; content: string; at: string };

export type Notes = {
  summary: string;
  outline: OutlineSection[];
  actions: ActionItem[];
  decisions: string[];
  keyPoints: string[];
  openQuestions: string[];
  topics: string[];
  sentiment?: { positive: number; neutral: number; negative: number; tone: string };
  generatedAt: string;
};

export type FollowUp = { subject: string; body: string; at: string };

export type MeetingStatus =
  | "recording" // capture in progress
  | "processing" // transcribing remaining pieces / summarizing
  | "ready"
  | "needs_audio_processing" // imported/migrated audio not yet transcribed
  | "bot" // a notetaker bot is scheduled, joining, or in the call
  | "error";

export type BotInfo = {
  id: string;
  url: string;
  platform: string;
  joinAt: string | null;
  code: string; // Recall status code
  subCode?: string | null;
  message?: string | null;
  sentAt: string;
};

export type Meeting = {
  id: string;
  title: string;
  titleIsAuto: boolean;
  createdAt: string; // ISO start time
  updatedAt: string;
  duration: number; // seconds of captured audio
  status: MeetingStatus;
  error?: string;
  segments: Segment[];
  speakers: Record<string, string>; // id -> display name
  notes?: Notes;
  notesError?: string;
  chat: ChatMessage[];
  userNotes: string;
  tags: string[];
  starred: boolean;
  peaks: number[]; // waveform, 10 values per second, 0..1
  hasPcm: boolean; // continuous 16 kHz audio stored (playback + transcription)
  audioFiles: { name: string; type: string; key: string }[]; // original/compressed audio parts
  source: "recording" | "import" | "migrated" | "bot";
  bot?: BotInfo;
  language: string;
  marks?: number[]; // seconds tapped as "highlight this" while recording
  followup?: FollowUp;
};

export type PieceState = "pending" | "done" | "failed";

/** A ~30 second slice of 16 kHz mono PCM waiting to be (or already) transcribed. */
export type Piece = {
  meetingId: string;
  index: number;
  start: number; // seconds
  duration: number;
  state: PieceState;
  attempts: number;
  lastError?: string;
  notBefore?: number;
};
