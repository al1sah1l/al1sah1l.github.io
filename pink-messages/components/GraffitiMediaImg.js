/**
 * Shows a profile (or other) image the Graffiti way:
 * - normal http(s) or data: URLs are used as-is (older saves / local preview)
 * - anything else is treated as a Graffiti media URL → fetch bytes with getMedia, then blob: URL for <img>
 */
import { inject } from "vue";

const GET_MEDIA_ACCEPT = {
  types: ["image/*"],
  maxBytes: 10 * 1024 * 1024, // 10MB — class-friendly cap
};

export const GraffitiMediaImg = {
  name: "GraffitiMediaImg",
  props: {
    src: { type: String, default: "" },
    alt: { type: String, default: "" },
    imgClass: { type: String, default: "" },
  },
  inject: ["getSession", "getGraffiti"],
  data() {
    return { resolvedSrc: "", loadErr: false };
  },
  watch: {
    src: {
      handler() {
        this.reload();
      },
      immediate: true,
    },
  },
  methods: {
    revokeIfBlob() {
      if (this.resolvedSrc && String(this.resolvedSrc).startsWith("blob:")) {
        try {
          URL.revokeObjectURL(this.resolvedSrc);
        } catch {
          /* ignore */
        }
      }
      this.resolvedSrc = "";
    },
    async reload() {
      this.revokeIfBlob();
      this.loadErr = false;
      const u = (this.src && String(this.src).trim()) || "";
      if (!u) return;
      // Legacy / local: no Graffiti round-trip
      if (u.startsWith("data:") || /^https?:\/\//i.test(u)) {
        this.resolvedSrc = u;
        return;
      }
      const g = this.getGraffiti();
      const sess = this.getSession ? this.getSession() : null;
      try {
        const out = await g.getMedia(u, GET_MEDIA_ACCEPT, sess || null);
        if (out && out.data) {
          this.resolvedSrc = URL.createObjectURL(out.data);
        }
      } catch (e) {
        console.warn("Graffiti getMedia failed for", u, e);
        this.loadErr = true;
      }
    },
  },
  unmounted() {
    this.revokeIfBlob();
  },
  template: `
    <img
      v-if="resolvedSrc && !loadErr"
      :src="resolvedSrc"
      :class="imgClass"
      :alt="alt"
    />
    <div
      v-else-if="loadErr && src"
      :class="[imgClass, 'graffiti-media-fallback']"
      aria-hidden="true"
      title="Could not load image"
    >?</div>
  `,
};

export default GraffitiMediaImg;
