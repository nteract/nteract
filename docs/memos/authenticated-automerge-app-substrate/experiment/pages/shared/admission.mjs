// Client-safe admission outcomes. The Worker maps every internal denial reason
// to exactly one of these codes; browsers receive only the code, never the
// internal reason. For clients that send ADMISSION_CAPABILITY, a missing Page
// and a Page the caller cannot read share `page_access_denied`.
//
// `retry` describes what a client should do:
// - "refresh": refresh the credential, then reconnect with normal backoff.
// - "recheck": reconnect with normal backoff; HTTP discovery reports current access.
// - "stop": do not reconnect automatically; a person must act.
// - "backoff": transient; reconnect with exponential backoff.
export const ADMISSION_OUTCOMES = Object.freeze({
  sign_in_required: Object.freeze({ status: 401, close: 4401, retry: "refresh" }),
  page_access_denied: Object.freeze({ status: 403, close: 4403, retry: "recheck" }),
  page_deleted: Object.freeze({ status: 404, close: 4404, retry: "stop" }),
  // Only the owner and current viewers/editors learn a Page is in Trash.
  // Restore brings access back, so clients keep their local copy.
  page_trashed: Object.freeze({ status: 403, close: 4410, retry: "recheck" }),
  access_changed: Object.freeze({ status: 409, close: 4409, retry: "recheck" }),
  signing_key_rejected: Object.freeze({ status: 403, close: 4422, retry: "stop" }),
  temporarily_unavailable: Object.freeze({ status: 503, close: 4503, retry: "backoff" }),
  // Malformed request or native input. A newer client build may succeed.
  request_rejected: Object.freeze({ status: 400, close: 4400, retry: "backoff" }),
});

/** Sent by viewers that understand the unified missing/unreadable response.
 * Clients without it keep the legacy 404 for a missing Page, which the
 * deployed viewer's expired-registration recovery depends on. */
export const ADMISSION_CAPABILITY = Object.freeze({ header: "X-Pages-Admission", value: "1" });

const byClose = new Map(
  Object.entries(ADMISSION_OUTCOMES).map(([code, { close }]) => [close, code]),
);

/** Interpret a native sync socket close. Returns undefined for ordinary closes
 * (1000/1001/1006, or anything this protocol did not send). The close code is
 * authoritative; the reason string must agree or the close is ignored. */
export function admissionCloseOutcome(event) {
  const code = byClose.get(event?.code);
  if (!code || (event.reason !== undefined && event.reason !== "" && event.reason !== code))
    return undefined;
  return { code, ...ADMISSION_OUTCOMES[code] };
}
