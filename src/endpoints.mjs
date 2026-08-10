// The single source of truth for every backend REST path the CLI calls.
//
// `api.mjs` owns the HTTP CLIENT (base URL, bearer auth, get/post/patch/del/
// upload/raw, org resolution). THIS module owns the PATHS. When a route moves on
// the backend, change it HERE — nowhere else. Commands import `{ EP }` and pass
// the path into the client; they never inline "/api/…" strings.
//
// Paths are verified against the backend routers in
//   whissle_gateway_backend/pipecat-bot/routes/
//
// Conventions:
//   • Static paths are plain strings.
//   • Parameterized paths are small pure builder functions (id, phone, …).
//   • Org-scoped paths ("/api/orgs/{org}/…") take the org id as their FIRST arg.
//     The COMMAND still calls `resolveOrgId()` and passes the result in — this
//     module stays a pure path map with NO imports and NO side effects.

export const EP = {
  // ── identity ────────────────────────────────────────────────────────────────
  whoami: "/api/whoami",

  // ── agents + their sub-resources (kb / chat / embed are /api/agents/{id}/…) ──
  agents: {
    list: "/api/agents",
    create: "/api/agents",
    get: (id) => `/api/agents/${id}`,
    update: (id) => `/api/agents/${id}`,
    del: (id) => `/api/agents/${id}`,
    // Knowledge base (RAG). `kb` is the base — GET lists docs, POST adds a snippet.
    // `doc` is one document: PATCH edits its title/content (and reindexes it),
    // DELETE removes it and disarms any lookup tool it was feeding. Without
    // these, re-syncing knowledge from a source of truth can only ever ADD, so
    // an agent accumulates stale copies of the same document.
    kb: {
      base: (id) => `/api/agents/${id}/kb`,
      doc: (id, docId) => `/api/agents/${id}/kb/${docId}`,
      fromUrl: (id) => `/api/agents/${id}/kb/from-url`,
      upload: (id) => `/api/agents/${id}/kb/upload`,
    },
    // Interactive text chat with the agent's brain + tools.
    chatTurn: (id) => `/api/agents/${id}/chat/turn`,
    // Web embed (voice/text widget) config.
    embed: (id) => `/api/agents/${id}/embed`,
    // Saved-config history: every meaningful save is snapshotted; rollback
    // restores content only (deployment/routing untouched); clone = new draft.
    versions: (id) => `/api/agents/${id}/versions`,
    rollback: (id, vid) => `/api/agents/${id}/versions/${vid}/rollback`,
    clone: (id) => `/api/agents/${id}/clone`,
    // In-call conversation flow (the per-agent state machine). Authoring is a
    // PATCH of `{flow}` to `update` (add `?target=draft` to stage a draft);
    // these are the read-models + generate/trace + draft→live lifecycle.
    workflow: (id) => `/api/agents/${id}/workflow`,
    guardrails: (id) => `/api/agents/${id}/guardrails`,
    flowGenerate: (id) => `/api/agents/${id}/flow/generate`,
    flowTrace: (id) => `/api/agents/${id}/flow/trace`,
    publish: (id) => `/api/agents/${id}/publish`,
    discardDraft: (id) => `/api/agents/${id}/draft/discard`,
  },

  // ── embed SESSIONS: the public surface a browser runs an agent against ──────
  // Distinct from `agents.embed`, which is the agent's embed CONFIG (enable the
  // widget, set allowed origins). These are the runtime: mint a short-lived
  // session token, then open voice (offer) / text (chatTurn) / a browser-rendered
  // avatar (simliToken) with it. All four are PUBLIC routes authorized by the
  // token itself, not by a bearer key — only the mint takes a credential.
  //
  // A token minted with a SECRET (wsk_) key is server-trusted: it carries no
  // origin, so the browser can open the session from anywhere and the partner
  // never has to allowlist an origin on the Whissle side. A publishable (wpk_)
  // key mints an origin-bound, single-use token instead.
  embed: {
    sessionToken: "/api/embed/session-token",
    // WebRTC signaling. `?token=` + POST an SDP offer; PATCH trickles ICE.
    offer: "/api/embed/offer",
    // Text turn against the same session token (no WebRTC, no audio).
    chatTurn: "/api/embed/chat/turn",
    // Browser-direct Simli avatar token — `?token=` + `?avatar_id=`, so the
    // partner's page renders the avatar and our node does zero video codec.
    simliToken: "/api/embed/simli-token",
  },

  // ── action inbox: human-approval queue for post-call actions ────────────────
  // Key resolves the org (like /api/calls), so NOT org-prefixed.
  actions: {
    list: "/api/actions",
    count: "/api/actions/count",
    approve: (id) => `/api/actions/${id}/approve`,
    reject: (id) => `/api/actions/${id}/reject`,
    scheduled: "/api/actions/scheduled",
    cancelScheduled: (id) => `/api/actions/scheduled/${id}/cancel`,
  },

  // ── calls: records surface + outbound placement ─────────────────────────────
  calls: {
    start: "/api/calls/start",
    list: "/api/calls",
    get: (id) => `/api/calls/${id}`,
    audioUrl: (id) => `/api/calls/${id}/audio/url`,
    // Partner-facing outcome envelope — poll until `ready:true`.
    result: (id) => `/api/calls/${id}/result`,
  },

  // ── server-side managed outbound campaigns ──────────────────────────────────
  campaigns: {
    list: "/api/campaigns",
    create: "/api/campaigns",
    get: (id) => `/api/campaigns/${id}`,
    action: (id, action) => `/api/campaigns/${id}/${action}`, // pause | resume | cancel
  },

  // ── end-customer / contact records (key resolves the org, so NOT org-prefixed) ─
  customers: {
    list: "/api/customers",
    create: "/api/customers",
    import: "/api/customers/import",
    get: (id) => `/api/customers/${id}`,
    update: (id) => `/api/customers/${id}`,
    del: (id) => `/api/customers/${id}`,
  },

  // ── notetaker meetings ──────────────────────────────────────────────────────
  meetings: {
    list: "/api/meetings",
    create: "/api/meetings",
    get: (id) => `/api/meetings/${id}`,
    cancel: (id) => `/api/meetings/${id}/cancel`,
  },

  // ── à-la-carte model API ────────────────────────────────────────────────────
  models: {
    chat: "/api/models/chat",
    tts: "/api/models/tts",
    transcribe: "/api/models/transcribe",
    voices: "/api/models/voices",
  },

  // ── agent-type blueprints (discovery: /api/agent-types) ──────────────────────
  agentTypes: "/api/agent-types",

  // ── org-scoped: call analytics (/api/orgs/{org}/analytics) ───────────────────
  analytics: {
    query: (org) => `/api/orgs/${org}/analytics/query`,
    options: (org) => `/api/orgs/${org}/analytics/options`,
    charts: (org) => `/api/orgs/${org}/analytics/charts`,
  },

  // ── org-scoped: per-agent booking config (/api/orgs/{org}/appointments) ──────
  appointments: {
    settings: (org) => `/api/orgs/${org}/appointments`, // GET base = booking settings
    hours: (org) => `/api/orgs/${org}/appointments/hours`,
    blockedDates: (org) => `/api/orgs/${org}/appointments/blocked-dates`,
    blockedDate: (org, id) => `/api/orgs/${org}/appointments/blocked-dates/${id}`,
    calendar: (org) => `/api/orgs/${org}/appointments/calendar`,
  },

  // ── org-scoped: calling compliance (/api/orgs/{org}/compliance) ──────────────
  compliance: {
    suppressions: (org) => `/api/orgs/${org}/compliance/suppressions`,
    // `phone` must be URL-encoded by the caller (path segment).
    suppression: (org, phone) => `/api/orgs/${org}/compliance/suppressions/${phone}`,
    settings: (org) => `/api/orgs/${org}/compliance/settings`,
    events: (org) => `/api/orgs/${org}/compliance/events`,
  },

  // ── org-scoped: stored connector credentials (/api/orgs/{org}/credentials) ───
  connectors: {
    list: (org) => `/api/orgs/${org}/credentials`,
    create: (org) => `/api/orgs/${org}/credentials`,
    update: (org, id) => `/api/orgs/${org}/credentials/${id}`,
    del: (org, id) => `/api/orgs/${org}/credentials/${id}`,
    test: (org, id) => `/api/orgs/${org}/credentials/${id}/test`,
  },

  // ── org-scoped: MCP connector app store (/api/orgs/{org}/integrations) ───────
  integrations: {
    list: (org) => `/api/orgs/${org}/integrations`,
    add: (org) => `/api/orgs/${org}/integrations`,
    catalog: (org) => `/api/orgs/${org}/integrations/catalog`,
    oauthStart: (org, id) => `/api/orgs/${org}/integrations/${id}/oauth/start`,
    connect: (org, id) => `/api/orgs/${org}/integrations/${id}/connect`,
    attach: (org, id) => `/api/orgs/${org}/integrations/${id}/attach`,
    detach: (org, id) => `/api/orgs/${org}/integrations/${id}/detach`,
    remove: (org, id) => `/api/orgs/${org}/integrations/${id}`,
  },

  // ── org-scoped: workspace API keys (/api/orgs/{org}/api-keys) ────────────────
  keys: {
    list: (org) => `/api/orgs/${org}/api-keys`,
    create: (org) => `/api/orgs/${org}/api-keys`,
    reveal: (org, id) => `/api/orgs/${org}/api-keys/${id}/reveal`,
    del: (org, id) => `/api/orgs/${org}/api-keys/${id}`,
  },

  // ── org-scoped: Company Brain facts (/api/orgs/{org}/memory) ─────────────────
  memory: {
    list: (org) => `/api/orgs/${org}/memory`,
    add: (org) => `/api/orgs/${org}/memory`,
    confirm: (org, id) => `/api/orgs/${org}/memory/${id}/confirm`,
    del: (org, id) => `/api/orgs/${org}/memory/${id}`,
  },

  // ── org-scoped: phone numbers (/api/orgs/{org}/twilio) ───────────────────────
  numbers: {
    free: (org) => `/api/orgs/${org}/twilio/free`,
    available: (org) => `/api/orgs/${org}/twilio/free/available`,
    search: (org) => `/api/orgs/${org}/twilio/free/search`,
    purchase: (org) => `/api/orgs/${org}/twilio/free/purchase`,
    claim: (org, id) => `/api/orgs/${org}/twilio/free/${id}/claim`,
    release: (org, id) => `/api/orgs/${org}/twilio/free/${id}/release`,
    // Bind a number to an agent for inbound calls.
    inboundNumber: (org, agentId) => `/api/orgs/${org}/twilio/agents/${agentId}/inbound-number`,
  },

  // ── org-scoped: SMS delivery log + consent (/api/orgs/{org}/sms) ─────────────
  sms: {
    messages: (org) => `/api/orgs/${org}/sms/messages`,
    optOuts: (org) => `/api/orgs/${org}/sms/opt-outs`,
    // `phone` must be URL-encoded by the caller (path segment).
    optOut: (org, phone) => `/api/orgs/${org}/sms/opt-outs/${phone}`,
    consents: (org) => `/api/orgs/${org}/sms/consents`,
  },

  // ── org-scoped: workspace invitations (/api/orgs/{org}/invitations) ──────────
  team: {
    list: (org) => `/api/orgs/${org}/invitations`,
    create: (org) => `/api/orgs/${org}/invitations`,
    del: (org, id) => `/api/orgs/${org}/invitations/${id}`,
  },

  // ── org-scoped: custom HTTP/data tools (/api/orgs/{org}/tools) ───────────────
  tools: {
    list: (org) => `/api/orgs/${org}/tools`,
    create: (org) => `/api/orgs/${org}/tools`,
    update: (org, id) => `/api/orgs/${org}/tools/${id}`,
    del: (org, id) => `/api/orgs/${org}/tools/${id}`,
    attach: (org, id) => `/api/orgs/${org}/tools/${id}/attach`,
  },

  // ── org-scoped: billing wallet (/api/orgs/{org}/wallet) ──────────────────────
  wallet: {
    base: (org) => `/api/orgs/${org}/wallet`,
    ledger: (org) => `/api/orgs/${org}/wallet/ledger`,
  },
};
