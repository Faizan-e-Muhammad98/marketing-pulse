// Routes from Marketing controllers plus Reviews, Menuboards and Brandbook.
// Shared payment, order, inventory and guest APIs are deliberately excluded.
export const marketingRouteGroups = [
  [
    'marketing',
    'marketing-dashboard',
    'gift-card',
    'campaign',
    'journey',
    'loyalty',
    'active-announcement',
    'active-spotlights',
  ],
  [
    'spotlight',
    'featured-ad',
    'track',
    'bookmarks',
    'holidays',
    'review-management',
    'feedback',
    'screen',
    'playlist',
    'brandbook',
  ],
  [
    'ai/campaign',
    'ai/journey',
    'ai/reviews',
    'webhook/google-notification/review',
    'webhook/gift-cards',
    'webhook/yelp',
    'webhooks/arm',
  ],
];

export function nrqlString(value: string) {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

export function marketingPatterns(transaction = false) {
  // Each pattern must stay below New Relic's 256-character RLIKE limit.
  const prefix = transaction ? 'WebTransaction/[^/]+/[A-Z]+//?(api/)?' : '/(api/)?';
  return marketingRouteGroups.map((routes) => `${prefix}(${routes.join('|')})(/.*|[?].*|$)`);
}

export function isMarketingRequest(uri?: unknown, transaction?: unknown) {
  const value = typeof uri === 'string' && uri ? uri : transaction;
  if (typeof value !== 'string') return false;
  return marketingPatterns(!(typeof uri === 'string' && uri)).some((pattern) =>
    new RegExp(`^(?:${pattern})$`).test(value),
  );
}

export function marketingCondition(nameAttribute: 'name' | 'transactionName') {
  const uri = marketingPatterns()
    .map((p) => `\`request.uri\` RLIKE ${nrqlString(p)}`)
    .join(' OR ');
  const name = marketingPatterns(true)
    .map((p) => `${nameAttribute} RLIKE ${nrqlString(p)}`)
    .join(' OR ');
  // Prefer the actual URI: generic /api/* transaction names cannot establish ownership.
  return `((${uri}) OR (\`request.uri\` IS NULL AND (${name})))`;
}
