// Only numeric business IDs from the database may become SQL identifiers.
export function utilizationSql(businessId: number) {
  if (!Number.isSafeInteger(businessId) || businessId < 1) throw new Error('Invalid business ID');
  const schema = `"tenant_${businessId}"`;
  const recent = (column: string) => `${column} >= $2::timestamptz AND ${column} < $3::timestamptz`;
  const paid = `t."ticketPaymentStatus"::text IN ('full-paid', 'partial-refund')`;
  return `SELECT r.id,
    EXISTS (SELECT 1 FROM ${schema}.gift_card_settings s WHERE s."restaurantId" = r.id)
    AND (
      EXISTS (SELECT 1 FROM ${schema}.gift_card_ticket t JOIN ${schema}.payment p ON p."giftCardTicketId" = t.id
        WHERE t."restaurantId" = r.id AND ${paid} AND p."paymentStatus"::text IN ('full-paid','partial-refund') AND p.paid > 0 AND ${recent('p."createdAt"')})
      OR EXISTS (SELECT 1 FROM ${schema}.user_gift_card u JOIN ${schema}.gift_card g ON g.id = u.gift_card_id JOIN ${schema}.payment p ON p.id = u.payment_id
        WHERE g."restaurantId" = r.id AND p."paymentStatus"::text IN ('full-paid','partial-refund') AND p.paid > 0 AND ${recent('p."createdAt"')})
    ) AS "giftCards",
    EXISTS (SELECT 1 FROM ${schema}.loyalty l WHERE l."restaurantId" = r.id AND l.status::text = 'Active' AND l."deletedAt" IS NULL)
    AND (SELECT COALESCE(sum(CASE WHEN t."paymentInfo"->>'redeemedPoints' ~ '^[0-9]+([.][0-9]+)?$' THEN (t."paymentInfo"->>'redeemedPoints')::numeric ELSE 0 END),0)
      FROM ${schema}.ticket t WHERE t."restaurantId" = r.id AND ${paid} AND ${recent('t."createdAt"')}) > 1 AS loyalty,
    (EXISTS (SELECT 1 FROM ${schema}.marketing_email_log e WHERE e."restaurantId" = r.id AND e."sourceType"::text = 'Campaign'
      AND NULLIF(e."providerMessageId", '') IS NOT NULL AND ${recent('e."cognitoCreatedAt"')})
    OR EXISTS (SELECT 1 FROM ${schema}.customer_marketing_sms s WHERE s."restaurantId" = r.id AND s."campaignId" IS NOT NULL
      AND s."messageStatus"::text IN ('sent','delivered','read') AND ${recent('s."dateSent"')})) AS campaigns,
    EXISTS (SELECT 1 FROM ${schema}.review_response rr JOIN ${schema}.review rv ON rv.id = rr."reviewId"
      WHERE rv."restaurantId" = r.id AND rr.status::text = 'Active' AND NULLIF(trim(rr.content),'') IS NOT NULL AND ${recent('rr."createdAt"')}) AS arm,
    EXISTS (SELECT 1 FROM ${schema}.ticket t WHERE t."restaurantId" = r.id AND ${paid} AND ${recent('t."createdAt"')}
      AND (t."dealId" IS NOT NULL OR EXISTS (SELECT 1 FROM ${schema}.ticket_item i WHERE i."ticketId" = t.id AND i."dealId" IS NOT NULL AND i.status::text NOT IN ('void','rejected','cancelled','moved')))) AS deals,
    EXISTS (SELECT 1 FROM ${schema}.restaurant_customer_relation rc JOIN ${schema}.customer c ON c.id = rc."customerId"::text
      WHERE rc."restaurantId" = r.id AND (trim(c.email) ~* '^[^[:space:]@]+@[^[:space:]@.]+([.][^[:space:]@.]+)+$'
      OR (trim(c.phone_number) ~ '^[+]?[0-9 ()-]+$' AND length(regexp_replace(c.phone_number, '[^0-9]', '', 'g')) BETWEEN 7 AND 15))) AS guestbook,
    EXISTS (SELECT 1 FROM ${schema}.journey_result jr JOIN ${schema}.journey j ON j.id = jr."journeyId"
      WHERE j."restaurantId" = r.id AND jr.sent > 0 AND jr.channel::text IN ('Email','Text') AND ${recent('jr.date')}) AS journeys
    FROM ${schema}.restaurant r WHERE r.id = ANY($1::int[]) AND r."recordStatus"::text = 'Active' `;
}
