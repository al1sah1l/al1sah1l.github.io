/**
 * Pink Messages — Vue 3 + Vue Router (hash) on top of Graffiti.
 * Same idea as the plain-JS version: discover → merge → show.
 */

import { createApp, ref, reactive, provide } from "vue";
import { createRouter, createWebHashHistory } from "vue-router";
import { GraffitiDecentralized } from "https://esm.sh/@graffiti-garden/implementation-decentralized@0.0.9";

// --- one shared discovery name for the class, plus per-actor inboxes
const DISCOVERY_CHANNEL = "pink-messages-2026";

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
    byChannel.set(v.channel, { channel: v.channel, title: v.title, folder: v.folder, source: "join" });
  }
  for (const c of discoveredCreates.value) {
    if (c.actor !== session.value.actor) continue;
    const v = c.value;
    if (!byChannel.has(v.channel)) {
      byChannel.set(v.channel, { channel: v.channel, title: v.title, folder: v.folder, source: "create" });
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
  template: '<div class="placeholder"><p>Select a chat in the list or start a new one from the left.</p></div>',
};

const ChatView = {
  name: "ChatView",
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
    displayName(m) {
      const actor = this.senderId(m);
      const p = profileCache[actor];
      if (p && (p.firstName || p.lastName)) {
        return [p.firstName, p.lastName].filter(Boolean).join(" ").trim();
      }
      if (this.sess && actor === this.sess.actor) return "You";
      return "Someone";
    },
    avatarLetter(m) {
      const n = this.displayName(m);
      if (n && n !== "Someone" && n.length) return n.charAt(0).toUpperCase();
      return (this.senderId(m) || "?").charAt(0).toUpperCase();
    },
    photo(m) {
      const p = profileCache[this.senderId(m)];
      return p && p.photoURL ? p.photoURL : null;
    },
    formatTs(ts) {
      return formatTime(ts);
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
      globalStatus.value = ex ? "Updating Important…" : "Saving to Important…";
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
        this.err = "Important action failed: " + e.message;
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
        <div
          v-for="(o, idx) in messages"
          :key="o.url + (o.value && o.value.id ? o.value.id : String(idx))"
          :class="['msg-row', senderId(o) === (sess && sess.actor) ? 'mine' : 'theirs']"
          :data-msg-url="o.url"
        >
          <div :class="['msg-bubble', senderId(o) === (sess && sess.actor) ? 'mine' : 'theirs']">
            <div class="msg-meta" @click="goProfile(senderId(o))">
              <div class="avatar-wrap" @click.stop="goProfile(senderId(o))">
                <img v-if="photo(o)" :src="photo(o)" class="msg-avatar" alt="" />
                <div v-else class="msg-avatar ph" aria-hidden="true">{{ avatarLetter(o) }}</div>
              </div>
              <span class="sender-line">
                <button type="button" class="sender-name-btn" @click.stop="goProfile(senderId(o))">
                  {{ displayName(o) }}
                </button>
                <span> · </span>
                <span>{{ formatTs(o.value && o.value.published) }}</span>
              </span>
            </div>
            <div class="msg-body-line">{{ o.value && o.value.content }}</div>
          </div>
          <div class="msg-actions">
            <button
              type="button"
              class="btn-star"
              :class="{ saved: isImportantUrl(o.url) }"
              :disabled="impBusy"
              @click="onToggleImportant(o)"
            >{{ isImportantUrl(o.url) ? '★ Saved' : '☆ Save' }}</button>
          </div>
        </div>
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
        this.status = "Could not load Important list.";
        console.error(e);
      }
    },
    fmt(ts) {
      return formatTime(ts);
    },
    go(v) {
      this.onRouter().push({
        name: "chat",
        params: { chatId: routeIdFromChannel(v.chatChannel) },
        query: { highlight: v.target || undefined },
      });
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
  <div class="important-page card" style="padding:1.1rem; border: none; box-shadow: none; background: transparent">
    <h2 class="important-heading">Saved for you</h2>
    <p class="important-sub">Messages you starred in chat (kept in your private Graffiti space).</p>
    <p class="inline-status">{{ status }}</p>
    <ul class="important-list" v-show="status === ''">
      <li v-for="(o, i) in items" :key="(o.value && o.value.id) || o.url + i">
        <button type="button" class="important-item" @click="go(o.value)">
          <div class="imp-preview">{{ o.value.preview || '(no preview)' }}</div>
          <div class="imp-meta">{{ o.value.chatTitle || 'Chat' }} · {{ fmt(o.value.published) }}{{ senderLine(o.value) }}</div>
        </button>
      </li>
      <li v-if="items.length===0" class="chat-item-meta">No saved messages yet. Open a chat and use the star.</li>
    </ul>
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
      return "";
    },
    letter() {
      const n = this.nameLine;
      if (n && n.length) return n.charAt(0).toUpperCase();
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
  <div class="profile-page card" style="padding:1.25rem">
    <p v-if="loadBusy" class="inline-status">Loading profile…</p>
    <template v-else>
      <p v-if="err" class="error-msg" role="alert">{{ err }}</p>
      <div v-else>
      <div v-if="p" class="profile-hero">
        <img v-if="p.photoURL" :src="p.photoURL" class="profile-avatar" alt="Profile" />
        <div v-else class="profile-avatar ph" aria-hidden="true">{{ letter }}</div>
        <div>
          <h2 class="profile-name">{{ nameLine || 'Name not set' }}</h2>
          <p class="profile-actor">Id: <code>{{ actor }}</code></p>
        </div>
      </div>
      <p v-else class="empty-profile">Profile not set yet. They can add one in Pink Messages on their account.</p>
    </div>
    </template>
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
      photo: "",
      loadBusy: true,
      loadErr: "",
      saveErr: "",
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
      if (!s) {
        this.loadBusy = false;
        return;
      }
      try {
        invalidateProfileCache(s.actor);
        const p = await loadProfileForActor(s.actor);
        this.first = (p && p.firstName) || "";
        this.last = (p && p.lastName) || "";
        this.photo = (p && p.photoURL) || "";
      } catch (e) {
        this.loadErr = "Loading profile: " + e.message;
      } finally {
        this.loadBusy = false;
      }
    },
    async save() {
      const s = this.getSession();
      if (!s || this.saving) return;
      this.saving = true;
      this.saveErr = "";
      this.justSaved = false;
      try {
        await graffiti.post(
          {
            channels: [profileStorageChannel(s.actor)],
            value: {
              activity: "SetProfile",
              actor: s.actor,
              firstName: this.first.trim(),
              lastName: this.last.trim(),
              photoURL: this.photo.trim(),
              updated: Date.now(),
            },
          },
          s
        );
        invalidateProfileCache(s.actor);
        await loadProfileForActor(s.actor);
        this.justSaved = true;
        importantTick.value++;
      } catch (e) {
        this.saveErr = "Save failed: " + e.message;
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
  <div class="profile-edit card" style="padding:1.25rem; max-width: 28rem">
    <h2 class="important-heading" style="margin-top:0">Edit your profile</h2>
    <p class="inline-status" v-if="loadBusy">Loading profile…</p>
    <p v-if="loadErr" class="error-msg" role="alert">{{ loadErr }}</p>
    <form v-else @submit.prevent="save">
      <label>
        First name
        <input v-model="first" type="text" maxlength="80" placeholder="First" />
      </label>
      <label>
        Last name
        <input v-model="last" type="text" maxlength="80" placeholder="Last" />
      </label>
      <label>
        Photo URL
        <input v-model="photo" type="url" maxlength="2000" placeholder="https://…" />
      </label>
      <p v-if="saveErr" class="error-msg" role="alert">{{ saveErr }}</p>
      <p v-if="justSaved" class="inline-status" style="color:#86198f">Saved! <router-link :to="{ name: 'profile', params: { actor: meActor } }">View public page</router-link></p>
      <div class="modal-actions" style="margin-top:0.5rem; justify-content:flex-start">
        <button class="btn btn-primary" type="submit" :disabled="saving">{{ saving ? 'Saving…' : 'Save' }}</button>
      </div>
    </form>
  </div>
  `,
};

// -- shell: side bar + where the child route draws
const MainLayout = {
  name: "MainLayout",
  inject: ["getSession", "onRouter"],
  data() {
    return {
      selectedFolder: "All",
      showDiscover: false,
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
      return n === "home" || n === "chat";
    },
  },
  methods: {
    setFolder(f) {
      this.selectedFolder = f;
    },
    toggleDiscover() {
      this.showDiscover = !this.showDiscover;
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
      const title = this.newTitle.trim();
      if (!title) {
        this.newErr = "Please add a title.";
        return;
      }
      this.creating = true;
      this.newErr = "";
      this.newStatus = "Creating chat…";
      const channel = newChatChannel();
      const published = Date.now();
      const chatId = crypto.randomUUID();
      try {
        await graffiti.post(
          {
            channels: [DISCOVERY_CHANNEL],
            value: { activity: "Create", type: "Chat", id: chatId, title, folder: this.newFolder, channel, published },
          },
          s
        );
        await graffiti.post(
          {
            channels: [personalInboxChannel(s.actor)],
            value: {
              activity: "Join",
              id: crypto.randomUUID(),
              target: chatId,
              title,
              folder: this.newFolder,
              channel,
              published,
            },
          },
          s
        );
        this.newStatus = "Done!";
        this.closeNew();
        await loadEverything();
        this.onRouter().push({ name: "chat", params: { chatId: routeIdFromChannel(channel) } });
      } catch (e) {
        this.newErr = "Could not create chat: " + e.message;
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
      const v = obj.value;
      try {
        await graffiti.post(
          {
            channels: [personalInboxChannel(s.actor)],
            value: { activity: "Join", id: crypto.randomUUID(), target: v.id, title: v.title, folder: v.folder, channel: v.channel, published: Date.now() },
          },
          s
        );
        setDiscoverStatus("Joined!");
        await loadEverything();
        this.onRouter().push({ name: "chat", params: { chatId: routeIdFromChannel(v.channel) } });
      } catch (e) {
        setDiscoverStatus("Join failed: " + e.message);
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
      <router-link
        to="/"
        class="tab"
        :class="{ active: chatsTabActive }"
        active-class="router-link-active"
      >Chats</router-link>
      <router-link to="/important" class="tab" active-class="active">Important</router-link>
    </nav>

    <p class="global-status">{{ gStatus }}</p>

    <div class="app-layout">
      <div class="chats-layout">
        <aside class="sidebar card">
          <div class="sidebar-section">
            <div class="section-label">Folders</div>
            <div class="folder-pills" role="tablist" aria-label="Folders">
              <button type="button" class="folder-pill" :class="{ active: selectedFolder==='All' }" @click="setFolder('All')">All</button>
              <button type="button" class="folder-pill" :class="{ active: selectedFolder==='People' }" @click="setFolder('People')">People</button>
              <button type="button" class="folder-pill" :class="{ active: selectedFolder==='Groups' }" @click="setFolder('Groups')">Groups</button>
              <button type="button" class="folder-pill" :class="{ active: selectedFolder==='Verification' }" @click="setFolder('Verification')">Verification</button>
            </div>
          </div>

          <div class="sidebar-actions">
            <button type="button" class="btn btn-primary btn-block" @click="openNew">New chat</button>
            <button type="button" class="btn btn-secondary btn-block" @click="toggleDiscover">Discover chats</button>
          </div>

          <div v-show="showDiscover" class="discover-panel">
            <div class="section-label">Available to join</div>
            <p class="inline-status">{{ dStatus }}</p>
            <ul class="discover-list">
              <li v-for="(obj, j) in availableJoins" :key="(obj.value && obj.value.id) || j" class="join-row">
                <span>{{ obj.value.title }} · {{ obj.value.folder }}</span>
                <button type="button" class="btn btn-secondary btn-tiny" :disabled="joining" @click="joinChat(obj)">Join</button>
              </li>
              <li v-if="availableJoins.length===0" class="chat-item-meta" style="padding:0.5rem">No new public chats, or you already joined them all.</li>
            </ul>
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
            <p v-if="!listStatus && filtered.length===0" class="inline-status">No chats in this folder.</p>
          </div>
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
            Title
            <input v-model="newTitle" type="text" required maxlength="120" placeholder="e.g. Study group" />
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
      { path: "important", name: "important", component: ImportantView, meta: { title: "Important" } },
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
