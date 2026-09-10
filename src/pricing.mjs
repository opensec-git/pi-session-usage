// USD / million tokens. Snapshot reviewed against official documentation, not an invoice.
export const PRICING_SOURCE = "https://api-docs.deepseek.com/quick_start/pricing/";
export const REVIEWED_AT = "2026-09-10";
const FROM = Date.parse("2026-09-10T00:00:00Z");
const UNTIL = Date.parse("2026-09-24T00:00:00Z");
const PRO_RETIREMENT = Date.parse("2026-09-14T04:00:00Z");
const flashAliases = new Set(["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"]);
export function isPeak(time) {
  const date = new Date(time), day = date.getUTCDay(), hour = date.getUTCHours();
  return day >= 1 && day <= 5 && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
}
export function deepseekRates(model, time) {
  if (!Number.isFinite(time) || time < FROM || time >= UNTIL) return undefined;
  const flash = flashAliases.has(model) || (model === "deepseek-v4-pro" && time >= PRO_RETIREMENT);
  if (!flash && model !== "deepseek-v4-pro") return undefined;
  const factor = isPeak(time) ? 1 : 0.5;
  return { input: (flash ? 0.3 : 1.32) * factor, cacheRead: (flash ? 0.006 : 0.044) * factor,
    output: (flash ? 1.2 : 3.96) * factor, cacheWrite: 0 };
}
const validRate = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
export function calculateCost(usage, rates) {
  if (!rates || !["input", "output", "cacheRead", "cacheWrite"].every(key => validRate(rates[key]) && validRate(usage[key]))) return undefined;
  return ["input", "output", "cacheRead", "cacheWrite"].reduce((sum, key) => sum + usage[key] * rates[key] / 1e6, 0);
}
export function costFor(message, usage, model, startedAt, endedAt, overrides = {}) {
  const override = overrides[`${message.provider}/${message.model}`];
  if (override) {
    const cost = calculateCost(usage, override);
    return { costUsd: cost, costSource: cost === undefined ? "invalid-price-override" : "configured-estimate" };
  }
  // Never apply official DeepSeek prices to a reseller's identically named model.
  const official = message.provider === "deepseek" && (!model?.baseUrl || /^https:\/\/api\.deepseek\.com(?:\/|$)/.test(model.baseUrl));
  if (official) {
    const rates = deepseekRates(message.model, startedAt);
    const cost = calculateCost(usage, rates);
    const endCost = calculateCost(usage, deepseekRates(message.model, endedAt));
    return { costUsd: cost, costSource: cost === undefined ? "deepseek-price-unavailable" : "deepseek-list-price-estimate",
      pricingReviewedAt: REVIEWED_AT,
      pricingWarning: cost !== endCost ? "Request crossed a pricing boundary; estimate uses request start time" : undefined };
  }
  const cost = message.usage?.cost?.total;
  const nonzeroRates = model?.cost && Object.values(model.cost).some(value => typeof value === "number" && value > 0);
  return { costUsd: validRate(cost) && (cost > 0 || nonzeroRates) ? cost : undefined,
    costSource: validRate(cost) && (cost > 0 || nonzeroRates) ? "pi-cost-estimate" : "unpriced" };
}
