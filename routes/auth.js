import { Router } from "express";
import crypto from "crypto";
import fetch from "node-fetch";
import { trackStat } from "./gamification.js";
import {
  supabase, getUser, saveKrogerToken, getKrogerToken,
  oauthStates,
  KROGER_TOKEN_URL, KROGER_AUTH_URL, KROGER_API_BASE, REDIRECT_URI, APP_URL,
} from "../lib/utils.js";

const router = Router();

// ══ KROGER OAUTH ══════════════════════════════════════════════════════════════

router.get("/auth/kroger", (req, res) => {
  const { userId } = req.query;
  const scope = encodeURIComponent("cart.basic:write product.compact");
  const state = crypto.randomUUID();
  oauthStates.set(state, { userId: userId || "anonymous", createdAt: Date.now() });
  for (const [key, val] of oauthStates) {
    if (Date.now() - val.createdAt > 600000) oauthStates.delete(key);
  }
  const url = `${KROGER_AUTH_URL}?client_id=${process.env.KROGER_CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=${scope}&state=${encodeURIComponent(state)}`;
  res.redirect(url);
});

router.get("/auth/kroger/callback", async (req, res) => {
  const { code, state, error } = req.query;
  if (error || !code) return res.redirect(`${APP_URL}/profile.html?kroger=error`);
  const stateData = oauthStates.get(state);
  if (!stateData) {
    console.error("Kroger OAuth callback: invalid or expired state parameter");
    return res.redirect(`${APP_URL}/profile.html?kroger=error`);
  }
  oauthStates.delete(state);
  const userId = stateData.userId;
  try {
    const credentials = Buffer.from(
      `${process.env.KROGER_CLIENT_ID}:${process.env.KROGER_CLIENT_SECRET}`
    ).toString("base64");
    const tokenRes = await fetch(KROGER_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${credentials}` },
      body: `grant_type=authorization_code&code=${code}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`,
    });
    if (!tokenRes.ok) throw new Error(await tokenRes.text());
    const tokens = await tokenRes.json();
    const profileRes = await fetch(`${KROGER_API_BASE}/identity/profile`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    let krogerProfile = {};
    if (profileRes.ok) krogerProfile = (await profileRes.json()).data || {};
    const tokenData = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + tokens.expires_in * 1000,
      profile: krogerProfile,
    };
    await saveKrogerToken(userId, tokenData);
    if (userId !== "anonymous") {
      await supabase.from("profiles").update({ kroger_connected: true }).eq("id", userId);
      trackStat(userId, "kroger_connected").catch(() => {});
    }
    res.redirect(`${APP_URL}/?kroger=success`);
  } catch (err) {
    console.error("Kroger callback error:", err.message);
    res.redirect(`${APP_URL}/?kroger=error`);
  }
});

router.get("/auth/kroger/disconnect", async (req, res) => {
  const user = await getUser(req);
  if (user) {
    await supabase.from("kroger_tokens").delete().eq("user_id", user.id);
    await supabase.from("profiles").update({ kroger_connected: false }).eq("id", user.id);
  }
  res.json({ success: true });
});

// ══ PROFILE API ═══════════════════════════════════════════════════════════════

router.get("/api/profile", async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  const { data, error } = await supabase.from("profiles").select("*").eq("id", user.id).single();
  if (error) { console.error(error.message); return res.status(500).json({ error: "Something went wrong. Please try again." }); }
  const krogerData = await getKrogerToken(user.id);
  const isConnected = !!krogerData || !!data.kroger_connected;
  res.json({ ...data, kroger_connected: isConnected, kroger_profile: krogerData?.profile || null });
});

router.patch("/api/profile", async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  const allowed = ["full_name", "household_size", "dietary_preferences", "favorite_recipe_types", "preferred_store", "avatar_url"];
  const updates = {};
  for (const key of allowed) { if (req.body[key] !== undefined) updates[key] = req.body[key]; }
  updates.updated_at = new Date().toISOString();
  const { data, error } = await supabase.from("profiles").update(updates).eq("id", user.id).select().single();
  if (error) { console.error(error.message); return res.status(500).json({ error: "Something went wrong. Please try again." }); }
  res.json(data);
});

// ══ CONTACT FORM ═════════════════════════════════════════════════════════════

router.post("/api/contact", async (req, res) => {
  const { name, email, topic, message, website } = req.body;
  // Honeypot — bots fill this hidden field, humans don't
  if (website && website.trim() !== '') {
    console.log("Contact form honeypot triggered — rejecting spam");
    return res.json({ success: true }); // Fake success so bots don't retry
  }
  if (!name || !email || !topic || !message) {
    return res.status(400).json({ error: "All fields are required" });
  }
  const ALLOWED_TOPICS = ["general", "bug", "feature", "partnership", "press", "other"];
  const safeTopic = ALLOWED_TOPICS.includes(topic) ? topic : "other";
  try {
    const { error } = await supabase.from("contact_messages").insert({ name, email, topic: safeTopic, message });
    if (error) throw new Error(error.message);
    console.log(`Contact form: ${topic} from ${email}`);
    res.json({ success: true });
  } catch (err) {
    console.error("Contact form error:", err.message);
    res.status(500).json({ error: "Could not send message. Please try again." });
  }
});

// ══ SAVED LISTS API ══════════════════════════════════════════════════════════

router.get("/api/lists", async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  const { data, error } = await supabase.from("saved_lists").select("*").eq("user_id", user.id).order("created_at", { ascending: false });
  if (error) { console.error(error.message); return res.status(500).json({ error: "Something went wrong. Please try again." }); }
  res.json({ lists: data });
});

router.post("/api/lists", async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  const { name, items } = req.body;
  if (!name || !items) return res.status(400).json({ error: "name and items required" });
  const { data, error } = await supabase.from("saved_lists").insert({ user_id: user.id, name, items }).select().single();
  if (error) { console.error(error.message); return res.status(500).json({ error: "Something went wrong. Please try again." }); }
  trackStat(user.id, "list_created").catch(() => {});
  res.json(data);
});

router.delete("/api/lists/:id", async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  const { error } = await supabase.from("saved_lists").delete().eq("id", req.params.id).eq("user_id", user.id);
  if (error) { console.error(error.message); return res.status(500).json({ error: "Something went wrong. Please try again." }); }
  res.json({ success: true });
});

// Public share endpoint — no auth required
router.get("/api/lists/share/:id", async (req, res) => {
  try {
    const { data, error } = await supabase.from("saved_lists").select("name, items, created_at").eq("id", req.params.id).single();
    if (error || !data) return res.status(404).json({ error: "List not found" });
    res.json(data);
  } catch (e) { console.error(e.message); res.status(500).json({ error: "Something went wrong." }); }
});

// ══ EMAIL SUBSCRIBE ═════════════════════════════════════════════════════════

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ZIP_RE = /^\d{5}$/;

router.post("/api/subscribe", async (req, res) => {
  const { email, zip } = req.body;
  if (!email || !EMAIL_RE.test(email)) return res.status(400).json({ error: "Valid email is required" });
  if (!zip || !ZIP_RE.test(zip)) return res.status(400).json({ error: "Valid 5-digit zip is required" });
  try {
    const { data: existing } = await supabase.from("email_subscribers").select("id").eq("email", email.toLowerCase()).single();
    if (existing) return res.json({ success: true, message: "Already subscribed" });
    const { error } = await supabase.from("email_subscribers").insert({ email: email.toLowerCase(), zip, subscribed_at: new Date().toISOString() });
    if (error) throw new Error(error.message);
    console.log(`New subscriber: ${email} (${zip})`);
    res.json({ success: true });
  } catch (err) {
    console.error("Subscribe error:", err.message);
    res.status(500).json({ error: "Could not subscribe. Please try again." });
  }
});

export default router;
