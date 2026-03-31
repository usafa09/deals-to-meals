import { Router } from "express";
import crypto from "crypto";
import fetch from "node-fetch";
import {
  supabase, getUser,
  krogerTokens, oauthStates,
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
    krogerTokens.set(userId, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + tokens.expires_in * 1000,
      profile: krogerProfile,
    });
    if (userId !== "anonymous") {
      await supabase.from("profiles").update({ kroger_connected: true }).eq("id", userId);
    }
    res.redirect(`${APP_URL}/profile.html?kroger=success`);
  } catch (err) {
    console.error("Kroger callback error:", err.message);
    res.redirect(`${APP_URL}/profile.html?kroger=error`);
  }
});

router.get("/auth/kroger/disconnect", async (req, res) => {
  const user = await getUser(req);
  if (user) {
    krogerTokens.delete(user.id);
    await supabase.from("profiles").update({ kroger_connected: false }).eq("id", user.id);
  }
  res.json({ success: true });
});

// ══ PROFILE API ═══════════════════════════════════════════════════════════════

router.get("/api/profile", async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  const { data, error } = await supabase.from("profiles").select("*").eq("id", user.id).single();
  if (error) return res.status(500).json({ error: error.message });
  const krogerData = krogerTokens.get(user.id);
  res.json({ ...data, kroger_connected: !!krogerData, kroger_profile: krogerData?.profile || null });
});

router.patch("/api/profile", async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  const allowed = ["full_name", "household_size", "dietary_preferences", "favorite_recipe_types", "preferred_store"];
  const updates = {};
  for (const key of allowed) { if (req.body[key] !== undefined) updates[key] = req.body[key]; }
  updates.updated_at = new Date().toISOString();
  const { data, error } = await supabase.from("profiles").update(updates).eq("id", user.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ══ CONTACT FORM ═════════════════════════════════════════════════════════════

router.post("/api/contact", async (req, res) => {
  const { name, email, topic, message } = req.body;
  if (!name || !email || !topic || !message) {
    return res.status(400).json({ error: "All fields are required" });
  }
  try {
    const { error } = await supabase.from("contact_messages").insert({ name, email, topic, message });
    if (error) throw new Error(error.message);
    console.log(`Contact form: ${topic} from ${email}`);
    res.json({ success: true });
  } catch (err) {
    console.error("Contact form error:", err.message);
    res.status(500).json({ error: "Could not send message. Please try again." });
  }
});

export default router;
