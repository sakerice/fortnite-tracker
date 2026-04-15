import type { Tournament } from './types';

const API_BASE = 'https://open.faceit.com/data/v4';

// FACEIT の大会（Championship）をFortniteで検索
export async function fetchFaceitTournaments(apiKey: string): Promise<Tournament[]> {
  try {
    // Championship（大規模大会）のみ取得
    // Hub は /hubs?game=fortnite が404のため除外
    const championships = await fetchChampionships(apiKey);
    console.log(`[FACEIT] championships=${championships.length}`);
    return championships;
  } catch (e) {
    console.error(`[FACEIT] Error: ${e}`);
    return [];
  }
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

