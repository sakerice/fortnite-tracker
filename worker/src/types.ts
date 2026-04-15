export interface Tournament {
  id: string;
  name: string;
  url: string;
  startAt: number;       // Unix timestamp (seconds)
  endAt: number;
  isOnline: boolean;
  city?: string;
  countryCode?: string;
  numAttendees: number;
  events: TournamentEvent[];
  prizePools: PrizePool[];
  source: 'startgg' | 'manual';
  addedAt: number;       // Unix ms
}

export interface TournamentEvent {
  id: string;
  name: string;
  startAt: number;
  numEntrants: number;
  type?: number;   // 1=単体、2=チーム等
}

export interface PrizePool {
  id: string;
  totalAmount: number;
  currency: string;
}

export interface Env {
  TOURNAMENTS_KV: KVNamespace;
  STARTGG_API_TOKEN: string;
  STARTGG_GAME_ID?: string;   // Fortnite = 1842
}
