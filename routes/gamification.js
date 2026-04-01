import { Router } from "express";
import { supabase, getUser } from "../lib/utils.js";
import { BADGES, LEVELS, getLevelForXP, getNextLevel } from "../lib/badges.js";

const router = Router();

const FOUNDING_LIMIT = 250;
let foundingSpotsCache = { count: null, ts: 0 };

async function getFoundingCount() {
  if (Date.now() - foundingSpotsCache.ts < 5 * 60 * 1000 && foundingSpotsCache.count !== null) return foundingSpotsCache.count;
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
        if (data.savings) updates.total_savings = parseFloat(stats.total_savings || 0) + parseFloat(data.savings);
        if (data.savings && parseFloat(data.savings) >= 10) updates.max_single_savings = Math.max(stats.max_single_savings || 0, parseFloat(data.savings));
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

router.post("/api/stats/track", async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  const { event, data } = req.body;
  if (!event) return res.status(400).json({ error: "event required" });
  const result = await trackStat(user.id, event, data || {});
  res.json(result);
});

// Public — no auth required
router.get("/api/founding-spots", async (req, res) => {
  try {
    const claimed = await getFoundingCount();
    res.json({ total: FOUNDING_LIMIT, claimed, remaining: Math.max(0, FOUNDING_LIMIT - claimed) });
  } catch (e) { res.json({ total: FOUNDING_LIMIT, claimed: 0, remaining: FOUNDING_LIMIT }); }
});

export default router;
