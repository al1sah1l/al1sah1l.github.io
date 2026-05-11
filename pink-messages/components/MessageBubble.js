/**
 * One message row in a chat. Pulled out so the chat and Important list can use the
 * same bubble UI without duplicating all the template clutter.
 * — Pink Messages, 6.4500 style
 */

function localPhotoSrc(p) {
  if (!p) return null;
  const s = (p.photoUrl && String(p.photoUrl).trim()) || (p.photoData && String(p.photoData).trim()) || (p.photoURL && String(p.photoURL).trim()) || "";
  return s || null;
}

function localFormatTime(ts) {
  if (!ts) return "";
  try {
    const d = new Date(ts);
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

/** First letter for avatar fallback — skips leading @ so “@sam” → S, not @ */
function initialFromDisplayLabel(label) {
  if (!label || typeof label !== "string") return "";
  let s = label.trim();
  if (s.startsWith("@")) s = s.slice(1).trim();
  if (!s) return "";
  return s.charAt(0).toUpperCase();
}

export const MessageBubble = {
  name: "MessageBubble",
  props: {
    // The Graffiti object for a Send, or a slim object in Important that still has .url, .value
    message: { type: Object, required: true },
    senderProfile: { type: Object, default: null },
    isMine: { type: Boolean, default: false },
    isSaved: { type: Boolean, default: false },
    // optional second line: which chat the line came from (Important only)
    showChatTitle: { type: Boolean, default: false },
    chatTitle: { type: String, default: "" },
    // sidebar layout: a bit smaller / tighter
    compact: { type: Boolean, default: false },
    saveDisabled: { type: Boolean, default: false },
    /** One-shot CSS animation when this row first appears (e.g. after send). Parent clears flag quickly. */
    popIn: { type: Boolean, default: false },
    /** Brief pulse + “Saved” chip after starring — parent clears after ~1.5s */
    saveFlash: { type: Boolean, default: false },
  },
  emits: ["save-message", "open-profile"],
  computed: {
    photoSrc() {
      return localPhotoSrc(this.senderProfile);
    },
    senderActor() {
      const m = this.message;
      if (m && m.value && m.value.actor != null && m.value.actor !== "") return m.value.actor;
      return m && m.actor ? m.actor : "";
    },
    primaryName() {
      if (this.isMine) return "You";
      const p = this.senderProfile;
      if (p) {
        const n = [p.firstName, p.lastName].filter(Boolean).join(" ").trim();
        if (n) return n;
        if (p.username) return "@" + String(p.username).replace(/^@/, "");
      }
      return "Someone";
    },
    // Only show a separate @ line when we already showed a real name (avoid “@a @a”)
    usernameText() {
      const p = this.senderProfile;
      if (!p || !p.username) return "";
      const n = [p.firstName, p.lastName].filter(Boolean).join(" ").trim();
      if (!n) return "";
      return "@" + String(p.username).replace(/^@/, "");
    },
    avatarInitial() {
      // Own messages: primaryName is "You" — still use real name / username for the glyph (not actor id).
      if (this.isMine) {
        const p = this.senderProfile;
        if (p) {
          const full = [p.firstName, p.lastName].filter(Boolean).join(" ").trim();
          if (full) return initialFromDisplayLabel(full);
          if (p.username) return initialFromDisplayLabel(String(p.username));
        }
        return "Y";
      }
      if (this.primaryName && this.primaryName !== "Someone") {
        return initialFromDisplayLabel(this.primaryName) || "?";
      }
      // No profile yet — avoid actor id (random first letter); show neutral until load completes.
      return "?";
    },
    bodyText() {
      const m = this.message;
      if (!m || !m.value) return "";
      return m.value.content != null ? m.value.content : "";
    },
    /** Split text and http(s) links for simple, safe linkification (no full HTML). */
    bodyChunks() {
      const raw = this.bodyText || "";
      const re = /(https?:\/\/[^\s<]+)/gi;
      const out = [];
      let last = 0;
      let m;
      while ((m = re.exec(raw)) !== null) {
        if (m.index > last) out.push({ link: false, text: raw.slice(last, m.index) });
        out.push({ link: true, text: m[0] });
        last = m.index + m[0].length;
      }
      if (last < raw.length) out.push({ link: false, text: raw.slice(last) });
      if (out.length === 0) out.push({ link: false, text: raw });
      return out;
    },
    timeLine() {
      if (!this.message || !this.message.value) return "";
      return localFormatTime(this.message.value.published);
    },
  },
  methods: {
    onSave() {
      this.$emit("save-message", this.message);
    },
    onOpenProfile() {
      if (this.senderActor) this.$emit("open-profile", this.senderActor);
    },
  },
  template: `
  <div
    class="msg-row message-bubble-root"
    :class="[
      isMine ? 'mine' : 'theirs',
      compact && 'message-bubble--compact',
      popIn && 'msg-pop-in'
    ]"
    :data-msg-url="message && message.url"
  >
    <div :class="['msg-bubble', isMine ? 'mine' : 'theirs']">
      <p v-if="showChatTitle && chatTitle" class="msg-chat-title">{{ chatTitle }}</p>
      <div class="msg-meta" @click="onOpenProfile">
        <div class="avatar-wrap" @click.stop="onOpenProfile">
          <graffiti-media-img v-if="photoSrc" :src="photoSrc" img-class="msg-avatar" alt="" />
          <div v-else class="msg-avatar ph" aria-hidden="true">{{ avatarInitial }}</div>
        </div>
        <span class="sender-line">
          <button type="button" class="sender-name-btn" @click.stop="onOpenProfile">
            {{ primaryName }}
          </button>
          <span v-if="usernameText" class="msg-username"> {{ usernameText }}</span>
          <span> · </span>
          <span>{{ timeLine }}</span>
        </span>
      </div>
      <div class="msg-body-line">
        <template v-for="(chunk, ci) in bodyChunks" :key="'c' + ci">
          <a
            v-if="chunk.link"
            :href="chunk.text"
            class="msg-link"
            target="_blank"
            rel="noopener noreferrer"
            @click.stop
          >{{ chunk.text }}</a>
          <span v-else class="msg-text-part">{{ chunk.text }}</span>
        </template>
      </div>
    </div>
    <div class="msg-actions">
      <button
        type="button"
        class="btn-star"
        :class="{ saved: isSaved, 'btn-star--confirm': saveFlash }"
        :disabled="saveDisabled"
        @click.stop="onSave"
      >{{ isSaved ? "★ Saved" : "☆ Save" }}</button>
      <span v-if="saveFlash && isSaved" class="saved-confirm-chip" aria-live="polite">Saved</span>
    </div>
  </div>
  `,
};

export default MessageBubble;
