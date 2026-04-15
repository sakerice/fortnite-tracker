import type { Tournament } from './types';

const API_BASE = 'https://open.faceit.com/data/v4';

// FACEIT の大会（Championship）をFortniteで検索
export async function fetchFaceitTournaments(apiKey: string): Promise<Tournament[]> {
  const all: Tournament[] = [];

  try {
    // Championship（大規模大会）を取得
    const championships = await fetchChampionships(apiKey);
    all.push(...championships);

    // Hub（常設コミュニティリーグ）も取得
    const hubs = await fetchHubs(apiKey);
    all.push(...hubs);

    console.log(`[FACEIT] championships=${championships.length} hubs=${hubs.length} total=${all.length}`);
  } catch (e) {
    console.error(`[FACEIT] Error: ${e}`);
  }

  return all;
}

async function fetchChampionships(apiKey: string): Promise<Tournament[]> {
  const res = await fetch(
    `${API_BASE}/championships?game=fortnite&limit=20&offset=0`,
    { headers: { Authorization: `Bearer ${apiKey}` } }
  );

  if (!res.ok) {
    console.error(`[FACEIT] championships HTTP ${res.status}`);
    return [];
  }

  const data = (await res.json()) as any;
  const items: any[] = data.items ?? [];

  return items
    .filter(c => c.status !== 'finished')
    .map(c => ({
      id: `faceit_champ_${c.championship_id}`,
      name: c.name,
      url: `https://www.faceit.com/ja/championship/${c.championship_id}`,
      startAt: c.championship_start
        ? Math.floor(new Date(c.championship_start).getTime() / 1000)
        : 0,
      endAt: c.championship_end
        ? Math.floor(new Date(c.championship_end).getTime() / 1000)
        : 0,
      isOnline: true, // FACEITはオンライン前提
      city: undefined,
      countryCode: c.region === 'JP' ? 'JP' : undefined,
      numAttendees: c.slots ?? 0,
      events: [],
      prizePools: c.prizes
        ? [{ id: c.championship_id, totalAmount: c.prizes.amount ?? 0, currency: c.prizes.currency ?? 'USD' }]
        : [],
      source: 'faceit' as const,
      addedAt: Date.now(),
    }));
}

async function fetchHubs(apiKey: string): Promise<Tournament[]> {
  const res = await fetch(
    `${API_BASE}/hubs?game=fortnite&limit=20&offset=0`,
    { headers: { Authorization: `Bearer ${apiKey}` } }
  );

  if (!res.ok) {
    console.error(`[FACEIT] hubs HTTP ${res.status}`);
    return [];
  }

  const data = (await res.json()) as any;
  const items: any[] = data.items ?? [];

  // Hub は常設リーグなので「次回開催」として扱う
  return items.map(h => ({
    id: `faceit_hub_${h.hub_id}`,
    name: `[FACEIT Hub] ${h.name}`,
    url: `https://www.faceit.com/ja/hub/${h.hub_id}`,
    startAt: 0,
    endAt: 0,
    isOnline: true,
    city: undefined,
    countryCode: h.region === 'JP' ? 'JP' : undefined,
    numAttendees: h.players_joined ?? 0,
    events: [],
    prizePools: [],
    source: 'faceit' as const,
    addedAt: Date.now(),
  }));
}
