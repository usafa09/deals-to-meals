import { Router } from "express";
import { supabase, getUser } from "../lib/utils.js";
import { BADGES, LEVELS, getLevelForXP, getNextLevel, getWeeklyChallenges, getChallengeProgress, SAVINGS_MILESTONES } from "../lib/badges.js";

const router = Router();

const FOUNDING_LIMIT = 250;
let foundingSpotsCache = { count: null, ts: 0 };

async function getFoundingCount() {
  // Short cache (30s) to reduce race window for founding member badge
  if (Date.now() - foundingSpotsCache.ts < 30 * 1000 && foundingSpotsCache.count !== null) return foundingSpotsCache.count;
  try {
    const { count } = await supabase.from("profiles").select("id", { count: "exact", head: true });
    foundingSpotsCache = { count: count || 0, ts: Date.now() };
    return count || 0;
  } catch { return foundingSpotsCache.count || 0; }
}

export async function checkFoundingMember(userId) {
  if (!supabase || !userId) return;
  try {
    const { data: existing } = await supabase.from("user_badges").select("id").eq("user_id", userId).eq("badge_id", "founding_member").single();
    if (existing) return; // already has it
    const count = await getFoundingCount();
    if (count <= FOUNDING_LIMIT) {
      // Double-check with fresh DB count to minimize race window
      const { count: freshCount } = await supabase.from("user_badges").select("id", { count: "exact", head: true }).eq("badge_id", "founding_member");
      if ((freshCount || 0) >= FOUNDING_LIMIT) {
        console.log(`Founding Member limit reached (${freshCount} badges exist), skipping for ${userId}`);
        return;
      }
      await supabase.from("user_badges").insert({ user_id: userId, badge_id: "founding_member" });
      // Add XP
      const { data: stats } = await supabase.from("user_stats").select("xp, level").eq("user_id", userId).single();
      if (stats) {
        const newXp = (stats.xp || 0) + 50;
        const newLevel = getLevelForXP(newXp);
        await supabase.from("user_stats").update({ xp: newXp, level: newLevel.level }).eq("user_id", userId);
      }
      console.log(`Founding Member badge awarded to ${userId} (user #${count})`);
    }
  } catch (e) { console.error("checkFoundingMember error:", e.message); }
}

// ── Get or create user stats ────────────────────────────────────────────────
async function getOrCreateStats(userId) {
  const { data } = await supabase.from("user_stats").select("*").eq("user_id", userId).single();
  if (data) return data;
  // New user — create stats and check founding member
  const { data: created } = await supabase.from("user_stats").insert({ user_id: userId }).select().single();
  checkFoundingMember(userId).catch(() => {}); // async, don't block
  return created || { user_id: userId, recipes_generated: 0, recipes_saved: 0, total_savings: 0, lists_created: 0, lists_shared: 0, items_carted: 0, zip_codes_searched: [], kroger_connected: false, streak_weeks: 0, last_active_week: null, level: 1, xp: 0 };
}

// ── Check and award badges ──────────────────────────────────────────────────
export async function checkAndAwardBadges(userId, statsOverride) {
  try {
    const stats = statsOverride || await getOrCreateStats(userId);
    const { data: existingBadges } = await supabase.from("user_badges").select("badge_id").eq("user_id", userId);
    const earned = new Set((existingBadges || []).map(b => b.badge_id));
    const newBadges = [];

    for (const badge of BADGES) {
      if (earned.has(badge.id)) continue;
      try {
        if (badge.check(stats)) {
          await supabase.from("user_badges").insert({ user_id: userId, badge_id: badge.id });
          newBadges.push(badge);
          stats.xp = (stats.xp || 0) + badge.xp;
        }
      } catch (e) { /* badge check failed, skip */ }
    }

    if (newBadges.length > 0) {
      const newLevel = getLevelForXP(stats.xp);
      const leveledUp = newLevel.level > (stats.level || 1);
      await supabase.from("user_stats").update({ xp: stats.xp, level: newLevel.level, updated_at: new Date().toISOString() }).eq("user_id", userId);
      return { newBadges, leveledUp, newLevel: leveledUp ? newLevel : null, xp: stats.xp };
    }
    return { newBadges: [], leveledUp: false, newLevel: null, xp: stats.xp };
  } catch (e) { console.error("checkAndAwardBadges error:", e.message); return { newBadges: [], leveledUp: false }; }
}

// ── Track stat and check badges ─────────────────────────────────────────────
export async function trackStat(userId, event, data = {}) {
  if (!supabase || !userId) return { newBadges: [] };
  try {
    const stats = await getOrCreateStats(userId);
    const updates = { updated_at: new Date().toISOString() };

    // Update streak
    const currentWeek = new Date().toISOString().slice(0, 10).replace(/-/g, "W").slice(0, 7);
    if (stats.last_active_week !== currentWeek) {
      const lastWeekNum = stats.last_active_week ? parseInt(stats.last_active_week.replace(/\D/g, "")) : 0;
      const thisWeekNum = parseInt(currentWeek.replace(/\D/g, ""));
      if (thisWeekNum - lastWeekNum <= 1) {
        updates.streak_weeks = (stats.streak_weeks || 0) + 1;
      } else {
        updates.streak_weeks = 1;
      }
      updates.last_active_week = currentWeek;
    }

    switch (event) {
      case "recipe_generated":
        updates.recipes_generated = (stats.recipes_generated || 0) + (data.count || 1);
        if (data.savings) {
          updates.total_savings = parseFloat(stats.total_savings || 0) + parseFloat(data.savings);
          // Reset weekly savings on new week
          const currentWeekId = new Date().toISOString().slice(0, 10);
          if (stats.weekly_savings_reset !== currentWeekId.slice(0, 7)) {
            updates.weekly_savings = parseFloat(data.savings);
            updates.weekly_savings_reset = currentWeekId.slice(0, 7);
          } else {
            updates.weekly_savings = parseFloat(stats.weekly_savings || 0) + parseFloat(data.savings);
          }
          if (parseFloat(data.savings) >= 10) updates.max_single_savings = Math.max(stats.max_single_savings || 0, parseFloat(data.savings));
        }
        // Track meal type counts
        const mt = (data.mealType || "").toLowerCase();
        if (mt.includes("breakfast") || mt.includes("quick weeknight")) updates.breakfast_count = (stats.breakfast_count || 0) + (data.count || 1);
        if (mt.includes("dinner") || mt.includes("comfort") || mt.includes("slow cooker")) updates.dinner_count = (stats.dinner_count || 0) + (data.count || 1);
        if (mt.includes("lunch") || mt.includes("meal prep")) updates.lunch_count = (stats.lunch_count || 0) + (data.count || 1);
        if (data.diets?.length) updates.diet_recipe_count = (stats.diet_recipe_count || 0) + (data.count || 1);
        // Deal hunter score
        if (data.dealHunterPercent >= 50) updates.deal_hunter_achieved = true;
        break;
      case "recipe_saved":
        updates.recipes_saved = (stats.recipes_saved || 0) + 1;
        break;
      case "list_created":
        updates.lists_created = (stats.lists_created || 0) + 1;
        break;
      case "list_shared":
        updates.lists_shared = (stats.lists_shared || 0) + 1;
        break;
      case "items_carted":
        updates.items_carted = (stats.items_carted || 0) + (data.count || 1);
        break;
      case "zip_searched":
        if (data.zip && !(stats.zip_codes_searched || []).includes(data.zip)) {
          updates.zip_codes_searched = [...(stats.zip_codes_searched || []), data.zip];
        }
        break;
      case "kroger_connected":
        updates.kroger_connected = true;
        break;
    }

    await supabase.from("user_stats").update(updates).eq("user_id", userId);
    const merged = { ...stats, ...updates };
    return await checkAndAwardBadges(userId, merged);
  } catch (e) { console.error("trackStat error:", e.message); return { newBadges: [] }; }
}

// ══ API ENDPOINTS ═══════════════════════════════════════════════════════════

router.get("/api/badges", async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  try {
    const { data: earned } = await supabase.from("user_badges").select("badge_id, earned_at").eq("user_id", user.id);
    const earnedMap = {};
    (earned || []).forEach(b => { earnedMap[b.badge_id] = b.earned_at; });
    const badges = BADGES.map(b => ({
      id: b.id, name: b.name, emoji: b.emoji, desc: b.desc, xp: b.xp,
      earned: !!earnedMap[b.id], earnedAt: earnedMap[b.id] || null,
    }));
    res.json({ badges, earnedCount: earned?.length || 0, totalCount: BADGES.length });
  } catch (e) { res.status(500).json({ error: "Something went wrong." }); }
});

router.get("/api/stats", async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  try {
    const stats = await getOrCreateStats(user.id);
    const level = getLevelForXP(stats.xp || 0);
    const next = getNextLevel(stats.xp || 0);
    res.json({
      ...stats,
      level: level.level,
      levelName: level.name,
      nextLevel: next ? { level: next.level, name: next.name, xpNeeded: next.xp } : null,
      xpToNext: next ? next.xp - (stats.xp || 0) : 0,
    });
  } catch (e) { res.status(500).json({ error: "Something went wrong." }); }
});

const ALLOWED_TRACK_EVENTS = new Set(["recipe_generated", "recipe_saved", "list_created", "list_shared", "items_carted", "zip_searched", "kroger_connected"]);

router.post("/api/stats/track", async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  const { event, data } = req.body;
  if (!event) return res.status(400).json({ error: "event required" });
  if (!ALLOWED_TRACK_EVENTS.has(event)) return res.status(400).json({ error: "invalid event" });

  // Sanitize data to prevent stat inflation
  const safeData = {};
  if (data) {
    if (data.count != null) safeData.count = Math.max(1, Math.min(parseInt(data.count) || 1, 50));
    if (data.savings != null) safeData.savings = Math.max(0, Math.min(parseFloat(data.savings) || 0, 500));
    if (data.mealType) safeData.mealType = String(data.mealType).slice(0, 50);
    if (Array.isArray(data.diets)) safeData.diets = data.diets.slice(0, 10).map(d => String(d).slice(0, 30));
    if (data.dealHunterPercent != null) safeData.dealHunterPercent = Math.max(0, Math.min(parseFloat(data.dealHunterPercent) || 0, 100));
    if (data.zip) safeData.zip = String(data.zip).replace(/\D/g, "").slice(0, 5);
  }

  const result = await trackStat(user.id, event, safeData);
  res.json(result);
});

// Public — no auth required
router.get("/api/founding-spots", async (req, res) => {
  try {
    const claimed = await getFoundingCount();
    res.json({ total: FOUNDING_LIMIT, claimed, remaining: Math.max(0, FOUNDING_LIMIT - claimed) });
  } catch (e) { res.json({ total: FOUNDING_LIMIT, claimed: 0, remaining: FOUNDING_LIMIT }); }
});

// Simple zip → city lookup (top US zips)
const ZIP_CITIES = {"10001":"New York, NY","90210":"Beverly Hills, CA","60601":"Chicago, IL","77001":"Houston, TX","30301":"Atlanta, GA","45432":"Dayton, OH","80841":"Colorado Springs, CO","98101":"Seattle, WA","48201":"Detroit, MI","33101":"Miami, FL","85001":"Phoenix, AZ","97201":"Portland, OR","55401":"Minneapolis, MN","27601":"Raleigh, NC","84101":"Salt Lake City, UT","32801":"Orlando, FL","15201":"Pittsburgh, PA","75201":"Dallas, TX","02101":"Boston, MA","19101":"Philadelphia, PA"};
function zipToCity(zips) {
  if (!zips?.length) return "Unknown";
  // Use most-searched zip
  const counts = {};
  zips.forEach(z => { counts[z] = (counts[z]||0)+1; });
  const top = Object.entries(counts).sort((a,b)=>b[1]-a[1])[0]?.[0] || "";
  return ZIP_CITIES[top] || (top ? `Near ${top}` : "Unknown");
}

// Leaderboard — public
router.get("/api/leaderboard", async (req, res) => {
  try {
    const { data } = await supabase.from("user_stats").select("weekly_savings, level, streak_weeks, zip_codes_searched").order("weekly_savings", { ascending: false }).limit(20);
    const board = (data || []).filter(s => parseFloat(s.weekly_savings || 0) > 0).map((s, i) => ({
      rank: i + 1,
      savings: parseFloat(s.weekly_savings || 0).toFixed(2),
      level: s.level || 1,
      streak: s.streak_weeks || 0,
      city: zipToCity(s.zip_codes_searched),
    }));
    res.json({ leaderboard: board, week: new Date().toISOString().slice(0, 10) });
  } catch (e) { res.json({ leaderboard: [] }); }
});

// Challenges — requires auth
function getISOWeek() { const d = new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate()+3-(d.getDay()+6)%7); const w1 = new Date(d.getFullYear(),0,4); return 1+Math.round(((d-w1)/86400000-3+(w1.getDay()+6)%7)/7); }

router.get("/api/challenges", async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  try {
    const weekNum = getISOWeek();
    const challenges = getWeeklyChallenges(weekNum);
    const stats = await getOrCreateStats(user.id);
    const withProgress = challenges.map(c => ({
      ...c,
      progress: getChallengeProgress(c, stats),
      completed: getChallengeProgress(c, stats) >= c.target,
    }));
    res.json({ challenges: withProgress, week: weekNum });
  } catch (e) { res.status(500).json({ error: "Something went wrong." }); }
});

export default router;
