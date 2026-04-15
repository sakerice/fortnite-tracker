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

  const ACTIVE_STATUSES = new Set(['upcoming', 'ongoing', 'active', 'open_for_registration']);
  const now = Date.now() / 1000; // Unix秒

  return items
    .filter(c => ACTIVE_STATUSES.has(c.status))
    .map(c => {
      // championship_start はミリ秒の場合があるため判定して変換
      let startAt = 0;
      if (c.championship_start) {
        const raw = Number(c.championship_start);
        // 1e12 より大きければミリ秒
        startAt = raw > 1e12 ? Math.floor(raw / 1000) : Math.floor(raw);
      }

      // 過去の大会は除外（startAtが設定されていて過去の場合）
      if (startAt > 0 && startAt < now - 86400) return null;

      // 賞金: prizes配列からUSD換算を試みる
      const prizeAmount = Array.isArray(c.prizes)
        ? 0  // FACEITはfaceit_pointsのみでUSD額は非公開
        : (c.prizes?.amount ?? 0);

      return {
        id: `faceit_champ_${c.championship_id}`,
        name: c.name,
        url: `https://www.faceit.com/ja/championship/${c.championship_id}`,
        startAt,
        endAt: 0,
        isOnline: true,
        city: undefined,
        countryCode: c.region === 'JP' ? 'JP' : undefined,
        numAttendees: c.slots ?? 0,
        events: [],
        prizePools: prizeAmount > 0
          ? [{ id: c.championship_id, totalAmount: prizeAmount, currency: 'USD' }]
          : [],
        source: 'faceit' as const,
        addedAt: Date.now(),
      };
    })
    .filter((t): t is NonNullable<typeof t> => t !== null);
}

