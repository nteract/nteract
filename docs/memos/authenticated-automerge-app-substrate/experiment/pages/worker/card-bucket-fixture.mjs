// An in-memory Page assets bucket for card tests, with the R2 behavior the
// card writer leans on: a new etag per put, `customMetadata` on `head()`,
// and `onlyIf` conditions (`etagMatches`, `etagDoesNotMatch: "*"`) that make
// `put()` answer null instead of writing.
export function cardBucket() {
  let next = 0;
  return {
    objects: new Map(),
    reads: [],
    puts: 0,
    refused: 0,
    fail: false,
    /** Called with the key before a put applies; tests use it to hold one. */
    beforePut: null,
    /** Called with the key before a get answers; tests use it to slow one. */
    beforeGet: null,
    async put(key, value, options = {}) {
      this.puts++;
      if (this.fail) throw Error("object store unavailable");
      await this.beforePut?.(key);
      const current = this.objects.get(key);
      const onlyIf = options.onlyIf;
      if (onlyIf?.etagMatches !== undefined && current?.etag !== onlyIf.etagMatches) {
        this.refused++;
        return null;
      }
      if (onlyIf?.etagDoesNotMatch === "*" && current) {
        this.refused++;
        return null;
      }
      const object = {
        key,
        etag: `etag-${++next}`,
        text: String(value),
        customMetadata: { ...options.customMetadata },
      };
      this.objects.set(key, object);
      return { key, etag: object.etag, customMetadata: object.customMetadata };
    },
    async get(key) {
      this.reads.push(key);
      await this.beforeGet?.(key);
      const object = this.objects.get(key);
      return object ? { ...object, text: async () => object.text } : null;
    },
    async head(key) {
      const object = this.objects.get(key);
      return object ? { key, etag: object.etag, customMetadata: object.customMetadata } : null;
    },
    async delete(key) {
      this.objects.delete(key);
    },
    /** The stored card at `key`, parsed. */
    card(key) {
      const object = this.objects.get(key);
      return object ? JSON.parse(object.text) : undefined;
    },
    /** Store a card as a host would, outside any writer. */
    async seed(key, card) {
      return this.put(key, JSON.stringify(card), {
        customMetadata: { card_hash: card.card_hash, content_updated_at: "" },
      });
    },
  };
}
