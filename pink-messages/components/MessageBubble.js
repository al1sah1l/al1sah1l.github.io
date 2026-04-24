/**
 * One message row in a chat. Pulled out so the chat and Important list can use the
 * same bubble UI without duplicating all the template clutter.
 * — Pink Messages, 6.4500 style
 */

function localPhotoSrc(p) {
  if (!p) return null;
  const s = p.photoData || p.photoURL;
  return s && String(s).trim() ? s.trim() : null;
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
      if (this.primaryName && this.primaryName !== "Someone" && this.primaryName !== "You") {
        return this.primaryName.charAt(0).toUpperCase();
      }
      return (this.senderActor || "?").charAt(0).toUpperCase();
    },
    bodyText() {
      const m = this.message;
      if (!m || !m.value) return "";
      return m.value.content != null ? m.value.content : "";
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
    :class="[isMine ? 'mine' : 'theirs', compact && 'message-bubble--compact']"
    :data-msg-url="message && message.url"
  >
    <div :class="['msg-bubble', isMine ? 'mine' : 'theirs']">
      <p v-if="showChatTitle && chatTitle" class="msg-chat-title">{{ chatTitle }}</p>
      <div class="msg-meta" @click="onOpenProfile">
        <div class="avatar-wrap" @click.stop="onOpenProfile">
          <img v-if="photoSrc" :src="photoSrc" class="msg-avatar" alt="" />
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
      <div class="msg-body-line">{{ bodyText }}</div>
    </div>
    <div class="msg-actions">
      <button
        type="button"
        class="btn-star"
        :class="{ saved: isSaved }"
        :disabled="saveDisabled"
        @click.stop="onSave"
      >{{ isSaved ? "★ Saved" : "☆ Save" }}</button>
    </div>
  </div>
  `,
};

export default MessageBubble;
