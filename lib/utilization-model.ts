export const utilizationMetrics = [
  {
    key: 'giftCards',
    label: 'Gift cards',
    description: 'Gift card settings and a completed sale in the last 30 days.',
  },
  {
    key: 'loyalty',
    label: 'Loyalty',
    description:
      'An active tier and more than 1 point redeemed in total on paid orders created in the last 30 days.',
  },
  {
    key: 'campaigns',
    label: 'Campaigns',
    description: 'At least one campaign email or SMS sent in the last 30 days.',
  },
  {
    key: 'arm',
    label: 'ARM',
    description: 'At least one review reply recorded in the last 30 days.',
  },
  {
    key: 'deals',
    label: 'Deals',
    description: 'A ticket or item deal on a paid order created in the last 30 days.',
  },
  {
    key: 'guestbook',
    label: 'Guestbook',
    description: 'At least one linked guest with a valid email or phone format, at any time.',
  },
  {
    key: 'journeys',
    label: 'Journeys',
    description: 'At least one email or SMS sent through a journey in the last 30 days.',
  },
] as const;

export type UtilizationMetric = (typeof utilizationMetrics)[number]['key'];

export type UsageCounts = Record<UtilizationMetric, number>;

export type UtilizationBatch = {
  at: number;
  nextOffset: number | null;
  totalBusinesses: number;
  liveRestaurants: number;
  candidateRestaurants: number;
  checkedRestaurants: number;
  failedBusinesses: number;
  counts: UsageCounts;
};

export function emptyUsage(): UsageCounts {
  return { giftCards: 0, loyalty: 0, campaigns: 0, arm: 0, deals: 0, guestbook: 0, journeys: 0 };
}

export function addUsage(
  previous: UtilizationBatch | null,
  batch: UtilizationBatch,
): UtilizationBatch {
  const counts = { ...batch.counts };
  for (const { key } of utilizationMetrics) counts[key] += previous?.counts[key] || 0;
  return {
    ...batch,
    counts,
    liveRestaurants: batch.liveRestaurants + (previous?.liveRestaurants || 0),
    checkedRestaurants: batch.checkedRestaurants + (previous?.checkedRestaurants || 0),
    failedBusinesses: batch.failedBusinesses + (previous?.failedBusinesses || 0),
  };
}

export function utilizationInput(params: URLSearchParams, now = Date.now()) {
  const offset = Number(params.get('offset') || 0);
  const at = Number(params.get('at') || Math.floor(now / 300000) * 300000);
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset % 4 !== 0 ||
    !Number.isSafeInteger(at) ||
    at % 300000 !== 0 ||
    at > now ||
    now - at > 3600000
  )
    throw new Error('Invalid utilization page');
  return { offset, at, refresh: params.get('refresh') === '1' };
}
