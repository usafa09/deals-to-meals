export const BADGES = [
  { id: "first_recipe", name: "First Recipe", emoji: "🥇", desc: "Generated your first recipe", xp: 10, check: s => s.recipes_generated >= 1 },
  { id: "cart_pro", name: "Cart Pro", emoji: "🛒", desc: "Added items to your Kroger cart", xp: 15, check: s => s.items_carted >= 1 },
  { id: "saver_10", name: "Saver", emoji: "💰", desc: "Saved $10 on a single recipe", xp: 10, check: s => s.max_single_savings >= 10 },
  { id: "saver_50", name: "Super Saver", emoji: "💰💰", desc: "Saved $50 total", xp: 25, check: s => s.total_savings >= 50 },
  { id: "saver_100", name: "Extreme Saver", emoji: "💰💰💰", desc: "Saved $100 total", xp: 50, check: s => s.total_savings >= 100 },
  { id: "saver_250", name: "Savings Legend", emoji: "🏆", desc: "Saved $250 total", xp: 100, check: s => s.total_savings >= 250 },
  { id: "list_maker", name: "List Maker", emoji: "📋", desc: "Created your first shopping list", xp: 10, check: s => s.lists_created >= 1 },
  { id: "sharer", name: "Sharer", emoji: "🔗", desc: "Shared a recipe or list", xp: 10, check: s => s.lists_shared >= 1 },
  { id: "collector_5", name: "Collector", emoji: "❤️", desc: "Saved 5 recipes", xp: 15, check: s => s.recipes_saved >= 5 },
  { id: "collector_25", name: "Recipe Hoarder", emoji: "❤️", desc: "Saved 25 recipes", xp: 30, check: s => s.recipes_saved >= 25 },
  { id: "explorer_5", name: "Explorer", emoji: "🗺️", desc: "Searched deals in 5 different zip codes", xp: 20, check: s => (s.zip_codes_searched || []).length >= 5 },
  { id: "breakfast_10", name: "Breakfast Boss", emoji: "🍳", desc: "Generated 10 breakfast recipes", xp: 15, check: s => (s.breakfast_count || 0) >= 10 },
  { id: "dinner_10", name: "Dinner Champion", emoji: "🥘", desc: "Generated 10 dinner recipes", xp: 15, check: s => (s.dinner_count || 0) >= 10 },
  { id: "lunch_10", name: "Lunch Pro", emoji: "🥪", desc: "Generated 10 lunch recipes", xp: 15, check: s => (s.lunch_count || 0) >= 10 },
  { id: "health_nut", name: "Health Nut", emoji: "🥗", desc: "Generated 10 recipes with dietary filters", xp: 15, check: s => (s.diet_recipe_count || 0) >= 10 },
  { id: "kroger_connected", name: "Connected", emoji: "📱", desc: "Linked your Kroger account", xp: 10, check: s => s.kroger_connected },
  { id: "streak_3", name: "On a Roll", emoji: "🔥", desc: "Used Dishcount 3 weeks in a row", xp: 20, check: s => s.streak_weeks >= 3 },
  { id: "streak_8", name: "Dedicated", emoji: "🔥🔥", desc: "Used Dishcount 8 weeks in a row", xp: 40, check: s => s.streak_weeks >= 8 },
  { id: "streak_12", name: "Loyal Chef", emoji: "🔥🔥🔥", desc: "Used Dishcount 12 weeks in a row", xp: 75, check: s => s.streak_weeks >= 12 },
  { id: "deal_hunter_50", name: "Deal Hunter", emoji: "🎯", desc: "Used 50% of available deals in one session", xp: 20, check: s => s.deal_hunter_achieved },
  { id: "founding_member", name: "Founding Member", emoji: "🌟", desc: "One of the first 250 Dishcount users", xp: 50, check: s => s.is_founding_member, special: true },
];

export const LEVELS = [
  { level: 1, name: "Newbie", xp: 0 },
  { level: 2, name: "Home Cook", xp: 50 },
  { level: 3, name: "Budget Chef", xp: 120 },
  { level: 4, name: "Savings Pro", xp: 200 },
  { level: 5, name: "Deal Finder", xp: 300 },
  { level: 6, name: "Kitchen Star", xp: 420 },
  { level: 7, name: "Meal Master", xp: 560 },
  { level: 8, name: "Coupon King", xp: 720 },
  { level: 9, name: "Savings Legend", xp: 900 },
  { level: 10, name: "Deal Legend", xp: 1100 },
];

export function getLevelForXP(xp) {
  for (let i = LEVELS.length - 1; i >= 0; i--) {
    if (xp >= LEVELS[i].xp) return LEVELS[i];
  }
  return LEVELS[0];
}

export function getNextLevel(xp) {
  for (const l of LEVELS) {
    if (xp < l.xp) return l;
  }
  return null;
}

export const SAVINGS_MILESTONES = [25, 50, 100, 250, 500];

// Weekly challenges — deterministic based on ISO week number
const CHALLENGE_POOL = [
  { type: "recipes", icon: "🍽️", title: "Recipe Rush", desc: "Generate {n} recipes this week", targets: [3, 5, 8], xp: [25, 35, 50] },
  { type: "savings", icon: "💰", title: "Savings Sprint", desc: "Save ${n} this week", targets: [10, 25, 50], xp: [25, 35, 50] },
  { type: "meal_types", icon: "🍳", title: "Variety Chef", desc: "Try {n} different meal types", targets: [2, 3, 4], xp: [25, 30, 40] },
  { type: "save_recipes", icon: "❤️", title: "Bookmark Bonanza", desc: "Save {n} recipes this week", targets: [2, 3, 5], xp: [25, 30, 40] },
  { type: "lists", icon: "📋", title: "List Master", desc: "Create {n} shopping lists", targets: [1, 2, 3], xp: [25, 30, 35] },
  { type: "breakfast", icon: "🥞", title: "Breakfast Week", desc: "Generate {n} breakfast recipes", targets: [2, 3, 5], xp: [25, 30, 40] },
  { type: "healthy", icon: "🥗", title: "Eat Clean", desc: "Generate {n} recipes with dietary filters", targets: [2, 3, 5], xp: [25, 35, 45] },
  { type: "stores", icon: "🏪", title: "Store Explorer", desc: "Search deals in {n} different zip codes", targets: [2, 3, 5], xp: [25, 30, 40] },
];

export function getWeeklyChallenges(weekNum) {
  // Pick 3 challenges deterministically from pool based on week number
  const challenges = [];
  for (let i = 0; i < 3; i++) {
    const poolIdx = (weekNum * 3 + i) % CHALLENGE_POOL.length;
    const diffIdx = (weekNum + i) % 3; // easy/medium/hard
    const c = CHALLENGE_POOL[poolIdx];
    challenges.push({
      id: `${c.type}_w${weekNum}_${i}`,
      icon: c.icon,
      title: c.title,
      desc: c.desc.replace("{n}", c.targets[diffIdx]).replace("${n}", "$" + c.targets[diffIdx]),
      target: c.targets[diffIdx],
      xp: c.xp[diffIdx],
      type: c.type,
    });
  }
  return challenges;
}

export function getChallengeProgress(challenge, stats) {
  switch (challenge.type) {
    case "recipes": return Math.min(stats.recipes_generated || 0, challenge.target);
    case "savings": return Math.min(parseFloat(stats.weekly_savings || 0), challenge.target);
    case "meal_types": return Math.min((stats.breakfast_count > 0 ? 1 : 0) + (stats.lunch_count > 0 ? 1 : 0) + (stats.dinner_count > 0 ? 1 : 0), challenge.target);
    case "save_recipes": return Math.min(stats.recipes_saved || 0, challenge.target);
    case "lists": return Math.min(stats.lists_created || 0, challenge.target);
    case "breakfast": return Math.min(stats.breakfast_count || 0, challenge.target);
    case "healthy": return Math.min(stats.diet_recipe_count || 0, challenge.target);
    case "stores": return Math.min((stats.zip_codes_searched || []).length, challenge.target);
    default: return 0;
  }
}
