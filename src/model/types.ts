// Data model. Everything here lives on the device (IndexedDB) unless noted.
// Times are epoch milliseconds.

/** An interest tag. `key` is the canonical match key, `label` is what the person sees. */
export interface Tag {
  key: string;
  label: string;
}

export interface ShareChoices {
  role: boolean;
  company: boolean;
  links: boolean;
  tags: boolean;
}

/** Optional preferences that shape place suggestions. Never shared. */
export interface Comfort {
  quietPlaces: boolean;
  stepFree: boolean;
  dietary: string[];
}

export interface Profile {
  /** Random ID made on this device at first run. Not linked to any account. */
  deviceId: string;
  displayName: string;
  role: string;
  company: string;
  links: string[];
  tags: Tag[];
  share: ShareChoices;
  comfort: Comfort;
  createdAt: number;
  updatedAt: number;
}

/** The part of a profile another person receives when you connect. */
export interface SharedProfile {
  displayName: string;
  role?: string;
  company?: string;
  links?: string[];
  tags?: Tag[];
}

export type ConnectionState = 'pending-sent' | 'pending-received' | 'connected';

export interface Connection {
  id: string;
  profile: SharedProfile;
  state: ConnectionState;
  connectedAt?: number;
  /** Their relay mailbox: where we leave messages for them. */
  mailboxId?: string;
  /** Our relay mailbox for this connection: where they leave messages for us. */
  myMailboxId?: string;
  /** Proves to the relay that our mailbox is ours. Never shared. */
  myMailboxToken?: string;
  /** Their one-time pairing number, kept to ignore a repeated request from the same code. */
  theirNonce?: string;
  /** When a request was sent or received. */
  requestedAt?: number;
  /** How we connected. */
  via: 'face-to-face' | 'request' | 'demo';
  /** Per-connection secret (base64url), used to derive encryption keys. */
  sharedSecret?: string;
  scheduleSharing: boolean;
  /** Saved session IDs they chose to share with you. */
  sharedSessionIds: string[];
  /** Demo connections are labelled as demo everywhere they appear. */
  demo: boolean;
}

export interface Note {
  id: string;
  connectionId: string;
  text: string;
  chips: string[];
  createdAt: number;
}

export interface FollowUp {
  id: string;
  connectionId: string;
  text: string;
  due?: number;
  done: boolean;
}

export type EnergyLevel = 'steady' | 'up-for-it' | 'charged';
export type ProtectedKind = 'focus' | 'recharge' | 'off';
export type BreakKind = 'meal' | 'rest' | 'restroom';

export type MeetingRow = 'front' | 'middle' | 'back';
export type MeetingSide = 'left' | 'centre' | 'right';

/** A coarse spot picked by hand from a grid of room areas. Never device location. */
export interface MeetingSpot {
  row?: MeetingRow;
  side?: MeetingSide;
  byDoor?: boolean;
  aisleSeat?: boolean;
}

export type ScheduleItemType = 'session' | 'break' | 'invite' | 'catch-up' | 'protected';

export interface ScheduleItem {
  id: string;
  type: ScheduleItemType;
  start: number;
  end: number;
  title: string;
  place?: string;
  source: 'user' | 'auto' | 'invite';
  programmeSessionId?: string;
  breakKind?: BreakKind;
  protectedKind?: ProtectedKind;
  inviteId?: string;
  /** A saved session marked as Focus (F22): invites and nudges wait until it ends. */
  focus?: boolean;
}

export type InviteKind =
  | 'meal'
  | 'break-together'
  | 'sit-together'
  | 'walk-over'
  | 'arrive-together'
  | 'catch-up';

export interface Invite {
  id: string;
  /** Display name only. */
  senderName: string;
  /** Set when we sent it. */
  outgoing: boolean;
  kind: InviteKind;
  start: number;
  end: number;
  place?: string;
  programmeSessionId?: string;
  meetingSpot?: MeetingSpot;
  note?: string;
  createdAt: number;
  expiresAt: number;
  recipientIds: string[];
  /** Only filled in on the sender's side, and only with people who said yes. */
  acceptedIds: string[];
  status: 'pending' | 'accepted' | 'cancelled';
}

export interface CatchUpItem {
  programmeSessionId: string;
  title: string;
  paperUrl?: string;
  reason: 'clash';
  addedAt: number;
}

export interface EnergySetting {
  level: EnergyLevel;
  setAt: number;
}

/** A one-way connect code we've shown (QR, link or six-digit code). Requests to it arrive in its mailbox. */
export interface Intro {
  nonce: string;
  /** This code's P-256 public key (base64url), shown in the code. */
  publicKey?: string;
  /**
   * The matching private key: non-extractable, stored as a CryptoKey in IndexedDB, used to open requests sent to
   * this code. Intros saved before keys existed have neither field and are ignored.
   */
  privateKey?: CryptoKey;
  /**
   * Fallback for browsers that can't keep a CryptoKey in IndexedDB: the private key as JWK. Only stored when
   * needed; turned back into a CryptoKey when loaded.
   */
  privateJwk?: JsonWebKey;
  mailboxId: string;
  mailboxToken: string;
  createdAt: number;
  expiresAt: number;
}
