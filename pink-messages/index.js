/**
 * Pink Messages — Vue 3 + Vue Router (hash) on top of Graffiti.
 * Same idea as the plain-JS version: discover → merge → show.
 */

import { createApp, ref, reactive, provide, toRaw } from "vue";
import { createRouter, createWebHashHistory } from "vue-router";
import { GraffitiDecentralized } from "https://esm.sh/@graffiti-garden/implementation-decentralized@0.0.9";
import { MessageBubble } from "./components/MessageBubble.js";

// --- one shared discovery name for the class, plus per-actor inboxes
const DISCOVERY_CHANNEL = "pink-messages-2026";
const PROFILE_INDEX_CHANNEL = "pink-messages-2026-profiles";

function personalInboxChannel(actor) {
  return `${actor}/pink-messages`;
}

function profileStorageChannel(actor) {
  return `${actor}/pink-messages-profile`;
}

// grafiti channel for messages in a chat
function newChatChannel() {
  return `pink-messages/chat/${crypto.randomUUID()}`;
}

// URL only keeps the last uuid bit so it stays small
function channelFromRouteChatId(routeId) {
  if (!routeId) return null;
  return `pink-messages/chat/${routeId}`;
}

function routeIdFromChannel(channel) {
  if (!channel) return "";
  return channel.split("/").pop() || channel;
}

/** data URL (upload) or old photoURL from links */
function profilePhotoSrc(p) {
  if (!p) return null;
  const s = p.photoData || p.photoURL;
  return s && String(s).trim() ? s.trim() : null;
}

/** public-facing name (username is the main handle when set) */
function publicDisplayLine(p) {
  if (!p) return "Someone";
  if (p.username) return "@" + String(p.username).replace(/^@/, "");
  const n = [p.firstName, p.lastName].filter(Boolean).join(" ").trim();
  return n || "Someone";
}

// latest profile index rows; Explore tab reads from this after refreshProfileIndexList()
const profileIndexRows = ref([]);

/**
 * Publishes a small ProfileIndex object so the Explore page can list people without
 * crawling every actor. Full SetProfile (with a big data URL) stays on the personal channel.
 */
async function postProfileIndexCard(sess, { actor, username, firstName, lastName, updated }) {
  if (!sess) return;
  await graffiti.post(
    {
      channels: [PROFILE_INDEX_CHANNEL],
      value: {
        activity: "ProfileIndex",
        type: "ProfileIndex",
        actor,
        username: String(username || "").replace(/^@/, "").trim().toLowerCase() || "unnamed",
        firstName: firstName || "",
        lastName: lastName || "",
        updated: updated || Date.now(),
      },
    },
    sess
  );
}

/**
 * One place to save: personal SetProfile (full) + a tiny public index copy for search.
 * photoData is usually a data URL if the user used file upload; old saves may still have photoURL only.
 */
async function saveFullProfile(sessionObj, { firstName, lastName, username, photoData }) {
  const t = String(username || "")
    .replace(/^@/, "")
    .trim()
    .toLowerCase();
  const u = t.replace(/[^a-z0-9_]/g, "");
  if (u && u !== t) {
    throw new Error("Username: letters, numbers, and underscores only.");
  }
  if (t && t.length < 2) {
    throw new Error("Username should be at least 2 characters.");
  }
  const up = {
    activity: "SetProfile",
    actor: sessionObj.actor,
    firstName: String(firstName || "").trim(),
    lastName: String(lastName || "").trim(),
    username: t || "user_" + sessionObj.actor.slice(0, 6),
    photoData: photoData == null || photoData === "" ? null : String(photoData).trim() || null,
    updated: Date.now(),
  };
  await graffiti.post(
    { channels: [profileStorageChannel(sessionObj.actor)], value: up },
    sessionObj
  );
  await postProfileIndexCard(sessionObj, {
    actor: sessionObj.actor,
    username: up.username,
    firstName: up.firstName,
    lastName: up.lastName,
    updated: up.updated,
  });
  invalidateProfileCache(sessionObj.actor);
}

/** Rebuilds the in-memory list used by Explore; client-side search only needs this */
async function refreshProfileIndexList() {
  if (!session.value) return;
  const objs = await drainDiscover([PROFILE_INDEX_CHANNEL], GRAFFITI_OBJECT_SCHEMA, session.value);
  const byActor = new Map();
  for (const o of objs) {
    const v = o.value;
    if (!v || v.activity !== "ProfileIndex") continue;
    const a = v.actor;
    if (!a) continue;
    const t = v.updated || 0;
    const ex = byActor.get(a);
    if (!ex || t > (ex.value.updated || 0)) byActor.set(a, o);
  }
  profileIndexRows.value = Array.from(byActor.values())
    .map((o) => o.value)
    .sort((a, b) => (a.username || "").localeCompare(b.username || ""));
}

/**
 * If we already have a 1:1 with this person, return that row; otherwise null.
 * Compares otherActor in Join/Create metadata.
 */
function findDirectChatForPeer(otherActor) {
  if (!otherActor) return null;
  for (const r of chatRows.value) {
    if (r.chatKind === "direct" && r.otherActor === otherActor) {
      return r;
    }
  }
  return null;
}

/**
 * New group: Create + my Join, same as before, then navigate.
 * chatKind "group" is the default.
 */
async function runCreateGroupAndGo(sessionObj, { title, folder, onRoutePush }) {
  if (!sessionObj) return;
  const t = String(title).trim();
  if (!t) {
    throw new Error("Add a name for the conversation.");
  }
  const channel = newChatChannel();
  const published = Date.now();
  const chatId = crypto.randomUUID();
  const createVal = {
    activity: "Create",
    type: "Chat",
    id: chatId,
    title: t,
    folder: folder,
    channel,
    published,
    chatKind: "group",
  };
  await graffiti.post(
    { channels: [DISCOVERY_CHANNEL], value: createVal },
    sessionObj
  );
  const joinVal = {
    activity: "Join",
    id: crypto.randomUUID(),
    target: chatId,
    title: t,
    folder,
    channel,
    published,
    chatKind: "group",
  };
  await graffiti.post(
    { channels: [personalInboxChannel(sessionObj.actor)], value: joinVal },
    sessionObj
  );
  await loadEverything();
  if (onRoutePush) onRoutePush({ name: "chat", params: { chatId: routeIdFromChannel(channel) } });
}

/**
 * A direct (1:1) line in the People folder; the other person can see it in Discover the same as before.
 */
async function runStartDirectMessage(sessionObj, { otherActor, labelTitle, onRoutePush }) {
  if (!sessionObj) return;
  if (otherActor === sessionObj.actor) {
    throw new Error("You cannot start a room with yourself.");
  }
  const ex = findDirectChatForPeer(otherActor);
  if (ex) {
    if (onRoutePush) onRoutePush({ name: "chat", params: { chatId: routeIdFromChannel(ex.channel) } });
    return;
  }
  const title = String(labelTitle || "Direct message").trim();
  const channel = newChatChannel();
  const published = Date.now();
  const chatId = crypto.randomUUID();
  const createVal = {
    activity: "Create",
    type: "Chat",
    id: chatId,
    title,
    folder: "People",
    channel,
    published,
    chatKind: "direct",
    otherActor,
  };
  await graffiti.post(
    { channels: [DISCOVERY_CHANNEL], value: createVal },
    sessionObj
  );
  const joinVal = {
    activity: "Join",
    id: crypto.randomUUID(),
    target: chatId,
    title,
    folder: "People",
    channel,
    published,
    chatKind: "direct",
    otherActor,
  };
  await graffiti.post(
    { channels: [personalInboxChannel(sessionObj.actor)], value: joinVal },
    sessionObj
  );
  await loadEverything();
  if (onRoutePush) onRoutePush({ name: "chat", params: { chatId: routeIdFromChannel(channel) } });
}

const GRAFFITI_OBJECT_SCHEMA = {
  type: "object",
  properties: {
    url: { type: "string" },
    actor: { type: "string" },
    channels: { type: "array", items: { type: "string" } },
    value: { type: "object" },
    allowed: { type: "array", items: { type: "string" } },
  },
  required: ["url", "actor", "channels", "value"],
  additionalProperties: true,
};

const graffiti = new GraffitiDecentralized();
const session = ref(null);
const userHandle = ref("");
const loginMsg = ref("");

const chatRows = ref([]);
const discoveredCreates = ref([]);
const importantByMessageUrl = ref(new Map());

// profileCache[actor] = profile object from Graffiti, or null if we checked and found nothing
// undefined = not loaded yet
const profileCache = reactive({});

const globalStatus = ref("");
const discoverStatus = ref("");
function setDiscoverStatus(msg) {
  discoverStatus.value = msg;
}
const chatListStatus = ref("");

// bump this when Important data changes in other views (lets Important page refresh)
const importantTick = ref(0);

/** @type {import('vue-router').Router} */
let router = null;

async function drainDiscover(channels, schema, sess) {
  const objects = [];
  const stream = graffiti.discover(channels, schema, sess);
  for await (const chunk of stream) {
    if (chunk && chunk.object) objects.push(chunk.object);
    if (chunk && chunk.error) console.warn("discover warning:", chunk.error);
  }
  return objects;
}

async function loadCreates() {
  if (!session.value) return;
  const objs = await drainDiscover([DISCOVERY_CHANNEL], GRAFFITI_OBJECT_SCHEMA, session.value);
  discoveredCreates.value = objs.filter((o) => o.value && o.value.activity === "Create");
}

async function loadJoins() {
  if (!session.value) return;
  const ch = personalInboxChannel(session.value.actor);
  const objs = await drainDiscover([ch], GRAFFITI_OBJECT_SCHEMA, session.value);
  return objs.filter((o) => o.value && o.value.activity === "Join");
}

async function loadImportantMarkers() {
  if (!session.value) return;
  const ch = personalInboxChannel(session.value.actor);
  const objs = await drainDiscover([ch], GRAFFITI_OBJECT_SCHEMA, session.value);
  const m = new Map();
  for (const o of objs) {
    if (o.value && o.value.activity === "MarkImportant" && o.value.target) {
      m.set(o.value.target, { importantUrl: o.url });
    }
  }
  importantByMessageUrl.value = m;
}

async function buildChatRows() {
  if (!session.value) return;
  await loadCreates();
  const joins = await loadJoins();
  const byChannel = new Map();
  for (const j of joins) {
    const v = j.value;
    byChannel.set(v.channel, {
      channel: v.channel,
      title: v.title,
      folder: v.folder,
      source: "join",
      chatKind: v.chatKind || "group",
      otherActor: v.otherActor != null && v.otherActor !== "" ? v.otherActor : null,
    });
  }
  for (const c of discoveredCreates.value) {
    if (c.actor !== session.value.actor) continue;
    const v = c.value;
    if (!byChannel.has(v.channel)) {
      byChannel.set(v.channel, {
        channel: v.channel,
        title: v.title,
        folder: v.folder,
        source: "create",
        chatKind: v.chatKind || "group",
        otherActor: v.otherActor || null,
      });
    }
  }
  const list = Array.from(byChannel.values());
  list.sort((a, b) => a.title.localeCompare(b.title));
  chatRows.value = list;
}

async function refreshUserHandle() {
  if (!session.value) {
    userHandle.value = "";
    return;
  }
  try {
    // Prefer the friendly @username from SetProfile; fall back to Graffiti's handle
    const p = await loadProfileForActor(session.value.actor);
    if (p && p.username) {
      userHandle.value = "@" + String(p.username).replace(/^@/, "");
      return;
    }
  } catch {
    /* use fallbacks below */
  }
  try {
    userHandle.value = await graffiti.actorToHandle(session.value.actor);
  } catch {
    userHandle.value = session.value.actor.slice(0, 18) + "…";
  }
}

/**
 * Get latest SetProfile for a user (others can read; posted on their /pink-messages-profile channel)
 */
async function loadProfileForActor(actor) {
  if (actor in profileCache) {
    return profileCache[actor];
  }
  if (!actor || !session.value) {
    profileCache[actor] = null;
    return null;
  }
  try {
    const ch = profileStorageChannel(actor);
    const objs = await drainDiscover([ch], GRAFFITI_OBJECT_SCHEMA, session.value);
    const sets = objs
      .filter((o) => o.value && o.value.activity === "SetProfile" && o.value.actor === actor)
      .sort((a, b) => (b.value.updated || 0) - (a.value.updated || 0));
    if (sets.length === 0) {
      profileCache[actor] = null;
      return null;
    }
    profileCache[actor] = sets[0].value;
    return sets[0].value;
  } catch (e) {
    console.warn("profile load for", actor, e);
    profileCache[actor] = null;
    return null;
  }
}

function invalidateProfileCache(actor) {
  delete profileCache[actor];
}

async function ensureProfiles(actors) {
  const u = [...new Set(actors || [])].filter(Boolean);
  for (const a of u) {
    if (!(a in profileCache)) {
      // eslint-disable-next-line no-await-in-loop
      await loadProfileForActor(a);
    }
  }
}

async function loadEverything() {
  if (!session.value) return;
  try {
    chatListStatus.value = "Loading chats…";
    await buildChatRows();
    await loadImportantMarkers();
    importantTick.value++;
    await refreshProfileIndexList();
    chatListStatus.value = "";
  } catch (e) {
    console.error(e);
    chatListStatus.value = "Could not load data. Try again?";
  }
}

function formatTime(ts) {
  if (!ts) return "";
  try {
    const d = new Date(ts);
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Page views
// ---------------------------------------------------------------------------

const HomeView = {
  name: "HomeView",
  template:
    '<div class="main-page-full"><div class="placeholder main-page-inner"><p>Your thread opens in this area. Use the <strong>Chats</strong> list on the left, or the <strong>Explore</strong> tab (sidebar) to find people and start a new chat.</p></div></div>',
};

/**
 * Hub: search public profile index, start a 1:1, or open the new-group modal (parent provides it).
 */
const ExploreView = {
  name: "ExploreView",
  props: {
    // Public “Create” posts on the class discovery channel (same list the old Chats sidebar used)
    availableJoins: { type: Array, default: () => [] },
    dStatus: { type: String, default: "" },
    joining: { type: Boolean, default: false },
  },
  emits: ["join"],
  inject: ["getSession", "onRouter", "openGroupCreate"],
  data() {
    return {
      q: "",
      busy: false,
      err: "",
      directBusy: null,
    };
  },
  computed: {
    me() {
      return this.getSession();
    },
    hits() {
      const s = String(this.q).trim().toLowerCase();
      const me = this.me && this.me.actor;
      const rows = profileIndexRows.value || [];
      const out = rows.filter((r) => r && r.actor && r.actor !== me);
      if (!s) return out;
      return out.filter((r) => {
        const u = (r.username || "").toLowerCase();
        const f = (r.firstName || "").toLowerCase();
        const l = (r.lastName || "").toLowerCase();
        return u.includes(s) || f.includes(s) || l.includes(s) || `${f} ${l}`.trim().includes(s);
      });
    },
  },
  async mounted() {
    this.busy = true;
    try {
      await refreshProfileIndexList();
      const acts = (profileIndexRows.value || []).map((r) => r.actor).filter(Boolean);
      await ensureProfiles(acts);
    } catch (e) {
      this.err = String(e.message || e);
    } finally {
      this.busy = false;
    }
  },
  methods: {
    photoFor(actor) {
      const p = profileCache[actor];
      return profilePhotoSrc(p);
    },
    fullName(r) {
      const n = [r.firstName, r.lastName].filter(Boolean).join(" ").trim();
      return n || "Name not set";
    },
    goProfile(actor) {
      this.onRouter().push({ name: "profile", params: { actor } });
    },
    async startDirect(r) {
      const s = this.me;
      if (!s || this.directBusy) return;
      this.err = "";
      this.directBusy = r.actor;
      globalStatus.value = "Starting conversation…";
      try {
        const un = (r.username || "").replace(/^@/, "");
        const label = un ? `With @${un}` : "Direct message";
        await runStartDirectMessage(s, {
          otherActor: r.actor,
          labelTitle: label,
          onRoutePush: (loc) => this.onRouter().push(loc),
        });
      } catch (e) {
        this.err = e.message || String(e);
      } finally {
        this.directBusy = null;
        globalStatus.value = "";
      }
    },
    startGroup() {
      if (typeof this.openGroupCreate === "function") this.openGroupCreate();
    },
  },
  template: `
  <div class="sidebar-embed explore-page" aria-label="Explore people">
    <div class="sidebar-embed-scroll">
      <h1 class="page-title">Explore</h1>
      <p class="page-lead">Search people, start a private message, or add a new group — all from this column.</p>

      <div class="explore-actions">
        <button type="button" class="btn btn-primary" @click="startGroup">＋ New chat</button>
        <p class="explore-hint">Creates a new conversation — you name it and pick a folder in the form.</p>
      </div>

      <div class="explore-discover">
        <div class="section-label">Chats to join</div>
        <p class="inline-status explore-discover-status">{{ dStatus }}</p>
        <ul class="discover-list" role="list">
          <li v-for="(obj, j) in availableJoins" :key="(obj.value && obj.value.id) || j" class="join-row">
            <span>{{ obj.value && obj.value.title ? obj.value.title : "Chat" }} · {{ (obj.value && obj.value.folder) || "" }}</span>
            <button type="button" class="btn btn-secondary btn-tiny" :disabled="joining" @click="$emit('join', obj)">Join</button>
          </li>
          <li v-if="availableJoins.length === 0" class="discover-list-empty">No new public invites, or you already joined them all.</li>
        </ul>
      </div>

      <label class="search-label">Search people</label>
      <input v-model="q" class="search-input" type="search" placeholder="Try a username, first or last name…" autocomplete="off" />

      <p v-if="err" class="error-msg" role="alert">{{ err }}</p>
      <p v-if="busy" class="inline-status">Loading directory…</p>

      <ul v-else class="explore-results" role="list">
        <li v-for="r in hits" :key="r.actor" class="explore-card card">
          <div class="explore-card-av">
            <img v-if="photoFor(r.actor)" :src="photoFor(r.actor)" alt="" class="explore-av" />
            <div v-else class="explore-av ph" aria-hidden="true">{{ (r.username || r.actor).charAt(0).toUpperCase() }}</div>
          </div>
          <div class="explore-card-body">
            <div class="explore-line1">{{ fullName(r) }}</div>
            <div class="explore-line2">@{{ (r.username || "unknown").replace(/^@/, "") }}</div>
          </div>
          <div class="explore-card-actions">
            <button type="button" class="btn btn-ghost" @click="goProfile(r.actor)">Profile</button>
            <button type="button" class="btn btn-secondary" :disabled="directBusy" @click="startDirect(r)">
              {{ directBusy === r.actor ? "Opening…" : "Message" }}
            </button>
          </div>
        </li>
        <li v-if="hits.length === 0 && !busy" class="explore-empty">No one matches that search yet, or the directory is still empty. When classmates save a public username on their profile, they show up here.</li>
      </ul>
    </div>
  </div>
  `,
};

const ChatView = {
  name: "ChatView",
  components: { MessageBubble },
  props: { chatId: { type: String, required: true } },
  inject: ["getSession", "onRouter"],
  data() {
    return {
      messages: [],
      err: "",
      sendBusy: false,
      impBusy: false,
      loadBusy: false,
      poller: null,
    };
  },
  computed: {
    sess() {
      return this.getSession();
    },
  },
  watch: {
    chatId: {
      handler() {
        this.hydrate();
      },
      immediate: false,
    },
    $route: {
      handler() {
        this.hydrate();
        this.$nextTick(() => this.scrollHighlight());
      },
      deep: true,
    },
  },
  methods: {
    row() {
      const need = channelFromRouteChatId(this.chatId);
      return chatRows.value.find((r) => r.channel === need) || null;
    },
    isImportantUrl(url) {
      return importantByMessageUrl.value.has(url);
    },
    senderId(m) {
      return m.value && m.value.actor != null && m.value.actor !== "" ? m.value.actor : m.actor;
    },
    // profile row for the bubble (keeps the template from touching profileCache directly)
    senderProfileFor(m) {
      const actor = this.senderId(m);
      return profileCache[actor] != null ? profileCache[actor] : null;
    },
    async hydrate() {
      this.err = "";
      const r = this.row();
      if (!r) {
        this.messages = [];
        this.err = "That chat is not in your list — try Home or Discover first.";
        return;
      }
      this.loadBusy = true;
      globalStatus.value = "Loading chat…";
      try {
        if (!this.sess) return;
        await loadImportantMarkers();
        const objs = await drainDiscover([r.channel], GRAFFITI_OBJECT_SCHEMA, this.sess);
        this.messages = objs
          .filter((o) => o.value && o.value.activity === "Send")
          .sort((a, b) => (a.value.published || 0) - (b.value.published || 0));
        await ensureProfiles(this.messages.map((m) => this.senderId(m)));
        this.$nextTick(() => this.scrollHighlight());
      } catch (e) {
        console.error(e);
        this.err = "Could not load messages.";
      } finally {
        this.loadBusy = false;
        globalStatus.value = "";
      }
    },
    scrollHighlight() {
      const q = this.$route.query.highlight;
      if (!q) return;
      const s = String(q);
      if (!this.$el) return;
      const all = this.$el.querySelectorAll(".msg-row");
      for (const el of all) {
        if (el.dataset && el.dataset.msgUrl === s) {
          el.scrollIntoView({ block: "center" });
          el.classList.add("highlight-msg");
          setTimeout(() => el.classList.remove("highlight-msg"), 1400);
          break;
        }
      }
    },
    onSend() {
      const ta = this.$refs.ta;
      this.submitText(ta && ta.value ? String(ta.value) : "");
    },
    onComposerKeydown(e) {
      if (e.key !== "Enter") return;
      if (e.shiftKey) return; // new line
      e.preventDefault();
      this.onSend();
    },
    async submitText(text) {
      const t = String(text).trim();
      if (!this.sess || this.sendBusy) return;
      if (!t) return;
      const r = this.row();
      if (!r) return;
      this.sendBusy = true;
      this.err = "";
      globalStatus.value = "Sending…";
      try {
        await graffiti.post(
          {
            channels: [r.channel],
            value: {
              activity: "Send",
              type: "Message",
              id: crypto.randomUUID(),
              content: t,
              chatChannel: r.channel,
              chatTitle: r.title,
              actor: this.sess.actor,
              published: Date.now(),
            },
          },
          this.sess
        );
        if (this.$refs.ta) this.$refs.ta.value = "";
        await this.hydrate();
      } catch (e) {
        this.err = "Send failed: " + e.message;
      } finally {
        this.sendBusy = false;
        globalStatus.value = "";
      }
    },
    async onToggleImportant(o) {
      if (!this.sess || this.impBusy) return;
      this.impBusy = true;
      this.err = "";
      const ex = importantByMessageUrl.value.get(o.url);
      globalStatus.value = ex ? "Updating saved…" : "Saving…";
      try {
        if (ex) {
          await graffiti.delete(ex.importantUrl, this.sess);
          const next = new Map(importantByMessageUrl.value);
          next.delete(o.url);
          importantByMessageUrl.value = next;
        } else {
          const r = this.row();
          const posted = await graffiti.post(
            {
              channels: [personalInboxChannel(this.sess.actor)],
              value: {
                activity: "MarkImportant",
                id: crypto.randomUUID(),
                target: o.url,
                chatChannel: r ? r.channel : "",
                chatTitle: r ? r.title : "",
                preview: (o.value && o.value.content || "").slice(0, 160),
                senderActor: (o.value && o.value.actor) != null && o.value.actor !== "" ? o.value.actor : o.actor,
                published: Date.now(),
              },
            },
            this.sess
          );
          const next2 = new Map(importantByMessageUrl.value);
          next2.set(o.url, { importantUrl: posted.url });
          importantByMessageUrl.value = next2;
        }
        await this.hydrate();
        importantTick.value++;
      } catch (e) {
        this.err = "Could not update saved: " + e.message;
      } finally {
        this.impBusy = false;
        globalStatus.value = "";
      }
    },
    goProfile(actor) {
      this.onRouter().push({ name: "profile", params: { actor } });
    },
  },
  template: `
  <div class="chat-wrap">
    <div class="chat-view" v-if="row()">
      <div class="chat-header">
        <h2 class="chat-title">{{ row().title }}</h2>
        <span class="folder-badge">{{ row().folder }}</span>
      </div>
      <p v-if="loadBusy" class="inline-status" style="padding:0.75rem 1rem 0">Loading messages…</p>
      <div class="messages-area" ref="scrollBox">
        <message-bubble
          v-for="(o, idx) in messages"
          :key="o.url + (o.value && o.value.id ? o.value.id : String(idx))"
          :message="o"
          :sender-profile="senderProfileFor(o)"
          :is-mine="!!sess && senderId(o) === sess.actor"
          :is-saved="isImportantUrl(o.url)"
          :save-disabled="impBusy"
          @open-profile="goProfile($event)"
          @save-message="onToggleImportant"
        />
      </div>
      <p v-if="err" class="error-msg" role="alert">{{ err }}</p>
      <form class="composer" v-if="row()" @submit.prevent="onSend">
        <label class="sr-only" for="message-input">Message</label>
        <textarea
          id="message-input"
          class="message-input"
          ref="ta"
          rows="2"
          placeholder="Type a message… (Enter to send, Shift+Enter for a new line)"
          maxlength="4000"
          @keydown="onComposerKeydown"
        ></textarea>
        <button class="btn btn-primary" :disabled="sendBusy" type="button" @click="onSend">Send</button>
      </form>
    </div>
    <div v-else class="placeholder" style="min-height: 220px; display:flex; align-items:center; justify-content:center; flex:1; padding: 1.5rem">
      <p style="text-align:center; max-width: 24rem; margin:0">{{ err }}</p>
    </div>
  </div>
  `,
  mounted() {
    this.hydrate();
    this.poller = window.setInterval(() => {
      if (this.$route.name !== "chat" || this.$route.params.chatId !== this.chatId) return;
      this.hydrate();
    }, 12000);
    this._onFocus = () => {
      if (this.$route.name === "chat" && this.$route.params.chatId === this.chatId) {
        this.hydrate();
      }
    };
    window.addEventListener("focus", this._onFocus);
  },
  unmounted() {
    if (this.poller) clearInterval(this.poller);
    if (this._onFocus) window.removeEventListener("focus", this._onFocus);
  },
};

const ImportantView = {
  name: "ImportantView",
  inject: ["getSession", "onRouter"],
  data() {
    return { items: [], status: "" };
  },
  created() {
    this.load();
  },
  // when someone stars something in a chat, importantTick bumps and we re-fetch
  watch: {
    importantVersion: {
      handler() {
        this.load();
      },
    },
  },
  computed: {
    importantVersion() {
      return importantTick.value;
    },
  },
  methods: {
    async load() {
      this.status = "Loading…";
      this.items = [];
      const s = this.getSession();
      if (!s) {
        this.status = "";
        return;
      }
      try {
        const ch = personalInboxChannel(s.actor);
        const objs = await drainDiscover([ch], GRAFFITI_OBJECT_SCHEMA, s);
        this.items = objs
          .filter((o) => o.value && o.value.activity === "MarkImportant")
          .sort((a, b) => (b.value.published || 0) - (a.value.published || 0));
        await ensureProfiles(
          this.items
            .map((o) => o.value && o.value.senderActor)
            .filter(Boolean)
        );
        this.status = "";
      } catch (e) {
        this.status = "Could not load your important list.";
        console.error(e);
      }
    },
    go(v) {
      // Open the thread in the main panel, but keep this Important sidebar (query read by MainLayout)
      this.onRouter().push({
        name: "chat",
        params: { chatId: routeIdFromChannel(v.chatChannel) },
        query: {
          highlight: v.target || undefined,
          from: "important",
        },
      });
    },
    fmt(ts) {
      return formatTime(ts);
    },
    senderLine(v) {
      if (!v || !v.senderActor) return "";
      const p = profileCache[v.senderActor];
      if (p && (p.firstName || p.lastName)) {
        return " · " + [p.firstName, p.lastName].filter(Boolean).join(" ");
      }
      return "";
    },
  },
  template: `
  <div class="sidebar-embed important-page" aria-label="Important messages">
    <div class="sidebar-embed-scroll important-inner">
      <h1 class="page-title">Important</h1>
      <p class="page-lead">Starred lines you marked. Tap a row to open that conversation in the main area.</p>
      <p class="inline-status">{{ status }}</p>
      <ul class="important-list" v-show="status === ''" role="list">
        <li v-for="(o, i) in items" :key="(o.value && o.value.id) || o.url + i">
          <button type="button" class="important-item" @click="go(o.value)">
            <div class="imp-preview">{{ o.value.preview || "(no text)" }}</div>
            <div class="imp-meta">{{ o.value.chatTitle || "Chat" }} · {{ fmt(o.value.published) }}{{ senderLine(o.value) }}</div>
          </button>
        </li>
        <li v-if="items.length===0" class="empty-saved">Nothing in Important yet. In a chat, tap the star on a message to add it here.</li>
      </ul>
    </div>
  </div>
  `,
};

// -- public + edit profile
const ProfileView = {
  name: "ProfileView",
  props: { actor: { type: String, required: true } },
  inject: ["getSession"],
  data() {
    return { loadBusy: true, err: "", p: null };
  },
  watch: {
    actor: {
      handler() {
        this.hydrate();
      },
      immediate: true,
    },
  },
  computed: {
    nameLine() {
      if (!this.p) return "";
      if (this.p.firstName || this.p.lastName) {
        return [this.p.firstName, this.p.lastName].filter(Boolean).join(" ");
      }
      if (this.p.username) {
        return "@" + String(this.p.username).replace(/^@/, "");
      }
      return "";
    },
    avatarSrc() {
      return profilePhotoSrc(this.p) || null;
    },
    letter() {
      const n = this.nameLine;
      if (n && n.length) return n.charAt(0).toUpperCase();
      if (this.p && this.p.username) return this.p.username.charAt(0).toUpperCase();
      return (this.actor || "?").charAt(0).toUpperCase();
    },
  },
  methods: {
    async hydrate() {
      this.loadBusy = true;
      this.err = "";
      this.p = null;
      if (!this.actor) {
        this.loadBusy = false;
        this.err = "No profile id in the link.";
        return;
      }
      if (!this.getSession()) {
        this.loadBusy = false;
        return;
      }
      try {
        invalidateProfileCache(this.actor);
        this.p = await loadProfileForActor(this.actor);
      } catch (e) {
        this.err = e.message;
      } finally {
        this.loadBusy = false;
      }
    },
  },
  template: `
  <div class="main-page-full">
    <div class="main-page-inner profile-page card" style="margin:0 auto; padding:1.5rem">
    <p v-if="loadBusy" class="inline-status">Loading profile…</p>
    <template v-else>
      <p v-if="err" class="error-msg" role="alert">{{ err }}</p>
      <div v-else>
      <div v-if="p" class="profile-hero">
        <img v-if="avatarSrc" :src="avatarSrc" class="profile-avatar" alt="Profile" />
        <div v-else class="profile-avatar ph" aria-hidden="true">{{ letter }}</div>
        <div class="profile-text-block">
          <p v-if="p && p.username && (p.firstName || p.lastName)" class="profile-handle">@{{ (p.username || "").replace(/^@/, "") }}</p>
          <h2 class="profile-name">{{ nameLine || "Name not set" }}</h2>
          <p class="profile-actor">Account id: <code>{{ actor }}</code></p>
        </div>
      </div>
      <p v-else class="empty-profile">No public profile here yet. They can add one in Pink Messages (username + name) from Edit profile.</p>
    </div>
    </template>
    </div>
  </div>
  `,
};

const ProfileEditView = {
  name: "ProfileEditView",
  inject: ["getSession"],
  data() {
    return {
      first: "",
      last: "",
      user: "",
      // photoData: base64 data URL (stored in SetProfile) — we keep a copy here while editing
      photoData: "",
      loadBusy: true,
      loadErr: "",
      saveErr: "",
      fileErr: "",
      saving: false,
      justSaved: false,
    };
  },
  created() {
    this.hydrate();
  },
  methods: {
    async hydrate() {
      const s = this.getSession();
      this.loadBusy = true;
      this.loadErr = "";
      this.justSaved = false;
      this.fileErr = "";
      if (!s) {
        this.loadBusy = false;
        return;
      }
      try {
        invalidateProfileCache(s.actor);
        const p = await loadProfileForActor(s.actor);
        this.first = (p && p.firstName) || "";
        this.last = (p && p.lastName) || "";
        this.user = (p && p.username) ? String(p.username).replace(/^@/, "") : "";
        // new field photoData, or old photoURL link from earlier saves
        this.photoData = (p && (p.photoData || p.photoURL)) || "";
      } catch (e) {
        this.loadErr = "Loading profile: " + e.message;
      } finally {
        this.loadBusy = false;
      }
    },
    /**
     * read local file as a data URL so Graffiti can store a string the same as before
     * (huge avatars are blocked so we do not break small-object limits)
     */
    onProfilePhotoFile(ev) {
      this.fileErr = "";
      const f = ev && ev.target && ev.target.files && ev.target.files[0];
      if (!f) return;
      if (!f.type || !f.type.startsWith("image/")) {
        this.fileErr = "Pick an image (PNG, JPG, …)";
        return;
      }
      if (f.size > 750 * 1024) {
        this.fileErr = "Image is too large here — try a smaller one (under 750KB).";
        return;
      }
      const r = new FileReader();
      r.onload = () => {
        this.photoData = r.result;
      };
      r.onerror = () => {
        this.fileErr = "Could not read that file.";
      };
      r.readAsDataURL(f);
    },
    clearPhoto() {
      this.photoData = "";
    },
    async save() {
      const s = this.getSession();
      if (!s || this.saving) return;
      this.saving = true;
      this.saveErr = "";
      this.justSaved = false;
      try {
        await saveFullProfile(s, {
          firstName: this.first,
          lastName: this.last,
          username: this.user,
          photoData: this.photoData,
        });
        this.justSaved = true;
        await refreshProfileIndexList();
        await refreshUserHandle();
        importantTick.value++;
      } catch (e) {
        this.saveErr = (e && e.message) || String(e);
      } finally {
        this.saving = false;
      }
    },
  },
  computed: {
    meActor() {
      const s = this.getSession();
      return s ? s.actor : "";
    },
  },
  template: `
  <div class="main-page-full">
    <div class="main-page-inner profile-edit card" style="padding:1.75rem; margin:0 auto">
    <h1 class="page-title" style="text-align:center; margin-top:0">Edit profile</h1>
    <p class="page-lead" style="text-align:center">Set how you show up in chats, search, and on your public page. Your <strong>username</strong> is the easy way for classmates to find you.</p>
    <p class="inline-status" v-if="loadBusy" style="text-align:center">Loading…</p>
    <p v-if="loadErr" class="error-msg" role="alert">{{ loadErr }}</p>
    <form v-else class="edit-profile-form" @submit.prevent="save">
      <div class="photo-edit-row" v-if="photoData">
        <img :src="photoData" class="edit-photo-preview" alt="Preview" />
        <button type="button" class="btn btn-ghost btn-tiny" @click="clearPhoto">Remove</button>
      </div>
      <label>
        Photo
        <input type="file" accept="image/*" @change="onProfilePhotoFile" />
        <span class="field-hint">Saved as a data URL in Graffiti (fine for a class demo). You can add a new picture anytime.</span>
        <p v-if="fileErr" class="error-msg">{{ fileErr }}</p>
      </label>
      <label>
        Username
        <input v-model="user" type="text" maxlength="32" placeholder="e.g. sam_chen" />
        <span class="field-hint">Optional: letters, numbers, underscores. Leave empty and we make a small default. Shown with @ in the app.</span>
      </label>
      <label>
        First name
        <input v-model="first" type="text" maxlength="80" placeholder="First" />
      </label>
      <label>
        Last name
        <input v-model="last" type="text" maxlength="80" placeholder="Last" />
      </label>
      <p v-if="saveErr" class="error-msg" role="alert">{{ saveErr }}</p>
      <p v-if="justSaved" class="inline-status" style="color:#86198f; text-align:center">Saved! <router-link :to="{ name: 'profile', params: { actor: meActor } }">View public page</router-link></p>
      <div class="profile-save-row">
        <button class="btn btn-primary" type="submit" :disabled="saving">{{ saving ? "Saving…" : "Save" }}</button>
      </div>
    </form>
    </div>
  </div>
  `,
};

/**
 * When you're on Explore or Important, the real UI is in the sidebar; the main column only shows this hint.
 */
const MainEmptyView = {
  name: "MainEmptyView",
  template: `
  <div class="main-page-full main-messages-placeholder">
    <div class="placeholder main-page-inner">
      <p><strong>Messages</strong> show in this area when you open a chat. <strong>Explore</strong> and <strong>Important</strong> use the <strong>left column</strong> only — switch to the <strong>Chats</strong> tab to pick a room from your list.</p>
    </div>
  </div>
  `,
};

// -- shell: side bar + where the child route draws
const MainLayout = {
  name: "MainLayout",
  components: { ExploreView, ImportantView },
  inject: ["getSession", "onRouter"],
  provide() {
    // Explore in the sidebar calls this to open the “new chat” modal
    return { openGroupCreate: () => this.openNew() };
  },
  data() {
    return {
      selectedFolder: "All",
      modalOpen: false,
      newTitle: "",
      newFolder: "People",
      newStatus: "",
      newErr: "",
      creating: false,
      joining: false,
    };
  },
  computed: {
    session() {
      return this.getSession();
    },
    handle() {
      return userHandle.value;
    },
    gStatus() {
      return globalStatus.value;
    },
    listStatus() {
      return chatListStatus.value;
    },
    dStatus() {
      return discoverStatus.value;
    },
    rows() {
      return chatRows.value;
    },
    creates() {
      return discoveredCreates.value;
    },
    filtered() {
      return this.rows.filter((r) => {
        if (this.selectedFolder === "All") return true;
        return r.folder === this.selectedFolder;
      });
    },
    availableJoins() {
      const joined = new Set(this.rows.map((r) => r.channel));
      return this.creates.filter((c) => c.value && !joined.has(c.value.channel));
    },
    chatsTabActive() {
      const n = this.$route.name;
      const fromImp = String(this.$route.query.from || "") === "important";
      // “Chats” tab = normal list + chat only when we didn’t open the thread from Important
      if (n === "home") return true;
      if (n === "chat" && !fromImp) return true;
      return false;
    },
    exploreTabActive() {
      return this.$route.name === "explore";
    },
    // Keep the Important list in the left column even while a chat is open in the main area
    showImportantSidebar() {
      const n = this.$route.name;
      if (n === "important") return true;
      if (n === "chat" && String(this.$route.query.from || "") === "important") return true;
      return false;
    },
    importantTabActive() {
      return this.showImportantSidebar;
    },
  },
  methods: {
    setFolder(f) {
      this.selectedFolder = f;
    },
    openNew() {
      this.modalOpen = true;
      this.newTitle = "";
      this.newErr = "";
      this.newStatus = "";
      this.newFolder = "People";
    },
    closeNew() {
      this.modalOpen = false;
    },
    async createChat() {
      if (this.creating) return;
      const s = this.session;
      if (!s) return;
      this.creating = true;
      this.newErr = "";
      this.newStatus = "Creating…";
      try {
        await runCreateGroupAndGo(s, {
          title: this.newTitle,
          folder: this.newFolder,
          onRoutePush: (loc) => this.onRouter().push(loc),
        });
        this.newStatus = "Done!";
        this.closeNew();
      } catch (e) {
        this.newErr = e && e.message ? e.message : String(e);
        this.newStatus = "";
      } finally {
        this.creating = false;
      }
    },
    async joinChat(obj) {
      if (this.joining) return;
      this.joining = true;
      setDiscoverStatus("Joining chat…");
      const s = this.session;
      if (!s) {
        this.joining = false;
        return;
      }
      const v = obj && obj.value;
      if (!v || v.id == null || !v.channel) {
        setDiscoverStatus("Join failed: this invite looks broken. Try refreshing the page.");
        this.joining = false;
        return;
      }
      // Same shape as runCreateGroupAndGo / runStartDirectMessage — the SDK can choke on
      // null fields (e.g. otherActor on a group) or on Vue’s reactive proxy, so we build plain objects.
      const kind = v.chatKind || "group";
      const joinVal = {
        activity: "Join",
        id: crypto.randomUUID(),
        target: v.id,
        title: (v.title != null && String(v.title).trim()) || "Chat",
        folder: (v.folder != null && String(v.folder)) || "Groups",
        channel: v.channel,
        published: Date.now(),
        chatKind: kind,
      };
      if (kind === "direct" && v.otherActor != null && v.otherActor !== "") {
        joinVal.otherActor = v.otherActor;
      }
      const doc = {
        channels: [personalInboxChannel(s.actor)],
        value: joinVal,
      };
      try {
        await graffiti.post(JSON.parse(JSON.stringify(doc)), toRaw(s));
        setDiscoverStatus("Joined!");
        await loadEverything();
        this.onRouter().push({ name: "chat", params: { chatId: routeIdFromChannel(String(v.channel)) } });
      } catch (e) {
        setDiscoverStatus("Join failed: " + (e && e.message ? e.message : String(e)));
      } finally {
        this.joining = false;
      }
    },
    logout() {
      const s = this.session;
      if (s) graffiti.logout(s);
    },
    // `routeIdFromChannel` is a module function — templates only see `this`, so we wrap it
    channelToRouteId(ch) {
      return routeIdFromChannel(ch);
    },
  },
  template: `
  <div id="app-screen" class="screen">
    <header class="top-header">
      <div class="header-left">
        <span class="logo-dot" aria-hidden="true"></span>
        <router-link to="/" class="header-link header-title">Pink Messages</router-link>
      </div>
      <div class="header-right">
        <span class="user-handle">{{ handle }}</span>
        <router-link to="/profile/edit" class="btn btn-secondary btn-tiny" active-class="router-link-active">My profile</router-link>
        <button type="button" class="btn btn-ghost" @click="logout">Log out</button>
      </div>
    </header>

    <nav class="tab-bar" role="tablist" aria-label="Main">
      <!--
        Custom slot: a link to to="/" would otherwise get router-link-active on every
        child route (explore, important, …). We only add .active via chatsTabActive.
      -->
      <router-link v-slot="{ href, navigate }" to="/" custom>
        <a
          :href="href"
          class="tab"
          :class="{ active: chatsTabActive }"
          @click="(e) => navigate(e)"
        >Chats</a>
      </router-link>
      <router-link
        to="/explore"
        class="tab"
        :class="{ active: exploreTabActive }"
        active-class="active"
      >Explore</router-link>
      <router-link
        to="/important"
        class="tab"
        :class="{ active: importantTabActive }"
        active-class="active"
      >Important</router-link>
    </nav>

    <p class="global-status">{{ gStatus }}</p>

    <div class="app-layout">
      <div class="chats-layout" :class="{ 'chats-layout--wide-sidebar': $route.name === 'explore' }">
        <aside class="sidebar card" :class="{ 'sidebar--wide': $route.name === 'explore' }">
          <explore-view
            v-if="$route.name === 'explore'"
            key="ex"
            :available-joins="availableJoins"
            :d-status="dStatus"
            :joining="joining"
            @join="joinChat"
          />
          <important-view v-else-if="showImportantSidebar" key="im" />
          <template v-else>
            <div class="sidebar-section">
              <div class="section-label">Folders</div>
              <div class="folder-pills" role="tablist" aria-label="Folders">
                <button type="button" class="folder-pill" :class="{ active: selectedFolder==='All' }" @click="setFolder('All')">All</button>
                <button type="button" class="folder-pill" :class="{ active: selectedFolder==='People' }" @click="setFolder('People')">People</button>
                <button type="button" class="folder-pill" :class="{ active: selectedFolder==='Groups' }" @click="setFolder('Groups')">Groups</button>
                <button type="button" class="folder-pill" :class="{ active: selectedFolder==='Verification' }" @click="setFolder('Verification')">Verification</button>
              </div>
            </div>

            <div class="sidebar-section flex-grow">
              <div class="section-label">Your chats</div>
              <p class="inline-status">{{ listStatus }}</p>
              <ul class="chat-list">
                <li v-for="r in filtered" :key="r.channel">
                  <router-link
                    :to="{ name: 'chat', params: { chatId: channelToRouteId(r.channel) } }"
                    class="chat-item"
                    active-class="selected"
                  >
                    <span class="chat-item-title">{{ r.title }}</span>
                    <span class="chat-item-meta">{{ r.folder }}</span>
                  </router-link>
                </li>
              </ul>
              <p v-if="!listStatus && filtered.length===0" class="inline-status">No chats in this folder. Use <strong>Explore</strong> to find people or start a new chat.</p>
            </div>
          </template>
        </aside>

        <main class="main-panel card">
          <router-view />
        </main>
      </div>
    </div>

    <div v-show="modalOpen" id="modal-new-chat" class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-new-title">
      <div class="modal-backdrop" @click="closeNew"></div>
      <div class="modal-content card" @click.stop>
        <h2 id="modal-new-title">New chat</h2>
        <form @submit.prevent="createChat">
          <label>
            Name
            <input v-model="newTitle" type="text" required maxlength="120" placeholder="e.g. 6.4500 study" />
          </label>
          <label>
            Folder
            <select v-model="newFolder" required>
              <option value="People">People</option>
              <option value="Groups">Groups</option>
              <option value="Verification">Verification</option>
            </select>
          </label>
          <p class="inline-status">{{ newStatus }}</p>
          <p v-if="newErr" class="error-msg" role="alert">{{ newErr }}</p>
          <div class="modal-actions">
            <button type="button" class="btn btn-ghost" @click="closeNew">Cancel</button>
            <button class="btn btn-primary" :disabled="creating" type="submit">Create</button>
          </div>
        </form>
      </div>
    </div>
  </div>
  `,
};

// Root: login
const Root = {
  name: "Root",
  setup() {
    provide("getSession", () => session.value);
    provide("onRouter", () => router);
    const onLogin = () => {
      loginMsg.value = "Opening Graffiti login…";
      graffiti
        .login()
        .catch((e) => {
          loginMsg.value = "Login error: " + (e && e.message ? e.message : String(e));
        });
    };
    return { session, userHandle, loginMsg, onLogin };
  },
  template: `
  <div class="app-root">
    <div v-show="!session" id="login-screen" class="screen">
      <div class="login-card card">
        <h1 class="app-title">Pink Messages</h1>
        <p class="login-blurb">A small pastel chat powered by Graffiti, now with a tiny router. Log in, pick a room, and star things you need later.</p>
        <button type="button" class="btn btn-primary" @click="onLogin">Log in with Graffiti</button>
        <p class="inline-status" aria-live="polite">{{ loginMsg }}</p>
      </div>
    </div>
    <router-view v-if="!!session" />
  </div>
  `,
};

// Router table — `profile/edit` is registered before the dynamic `profile/:actor` on purpose
const routes = [
  {
    path: "/",
    component: MainLayout,
    children: [
      { path: "", name: "home", component: HomeView, meta: { title: "Home" } },
      { path: "chat/:chatId", name: "chat", component: ChatView, props: true, meta: { title: "Chat" } },
      { path: "explore", name: "explore", component: MainEmptyView, meta: { title: "Explore" } },
      { path: "important", name: "important", component: MainEmptyView, meta: { title: "Important" } },
      { path: "profile/edit", name: "profileEdit", component: ProfileEditView, meta: { title: "Edit profile" } },
      { path: "profile/:actor", name: "profile", component: ProfileView, props: true, meta: { title: "Profile" } },
    ],
  },
];

router = createRouter({
  history: createWebHashHistory(),
  routes,
});

// Graffiti life-cycle (same as the old script, just updating Vue)
graffiti.sessionEvents.addEventListener("login", async (event) => {
  if (!(event instanceof CustomEvent)) return;
  const detail = event.detail;
  if (detail && detail.error) {
    loginMsg.value = "Login did not finish: " + (detail.error && detail.error.message ? detail.error.message : String(detail.error));
    return;
  }
  if (detail && detail.session) {
    loginMsg.value = "";
    session.value = detail.session;
    await refreshUserHandle();
    await loadEverything();
  }
});
graffiti.sessionEvents.addEventListener("logout", () => {
  session.value = null;
});

graffiti.sessionEvents.addEventListener("initialized", () => {});

const app = createApp(Root);
app.use(router);
app.mount("#app");
