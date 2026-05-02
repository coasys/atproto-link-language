/**
 * Settings for the AT Proto Link Language.
 *
 * Parsed from the JSON string returned by `languageSettings()` at
 * runtime. Provides sensible defaults.
 *
 * Spec §10.
 */

export interface RenderingSettings {
    /** Which records to create: native triples only, bluesky records only, or both */
    strategy: "native" | "bluesky" | "dual";
    /** Predicates treated as chat messages for Bluesky rendering */
    chatPredicates: string[];
    /** Whether to resolve expression URIs for content */
    resolveContent: boolean;
}

export type SyncMode = "bidirectional" | "publish-only" | "subscribe-only";

export type MembershipMode = "open" | "followers-only" | "list-only";

export interface FirehoseSettings {
    /** Enable firehose subscription (disable for polling-only) */
    enabled: boolean;
    /** Relay URL override */
    relay: string;
    /** Filter events by collection NSID */
    filterByCollection: boolean;
    /** Reconnect backoff base (ms) */
    reconnectBaseMs: number;
    /** Max reconnect backoff (ms) */
    reconnectMaxMs: number;
}

export interface AuthSettings {
    /** Auth method */
    method: "app-password" | "oauth";
    /** App password */
    appPassword: string;
}

export interface RateLimitSettings {
    /** Max writes per minute */
    maxWritesPerMinute: number;
    /** Max firehose events processed per second */
    maxEventsPerSecond: number;
}

export interface DualLanguageSettings {
    /** Whether this language coexists with another sync language */
    enabled: boolean;
    /** Predicates that should not be federated */
    excludePredicates: string[];
}

export interface ATProtoSettings {
    syncMode: SyncMode;
    rendering: RenderingSettings;
    firehose: FirehoseSettings;
    auth: AuthSettings;
    rateLimit: RateLimitSettings;
    membership: MembershipMode;
    dualLanguage: DualLanguageSettings;
}

/** Default settings — sensible defaults for bidirectional sync. */
export const DEFAULT_SETTINGS: ATProtoSettings = {
    syncMode: "bidirectional",
    rendering: {
        strategy: "dual",
        chatPredicates: ["flux://has_message", "sioc://content_of"],
        resolveContent: true,
    },
    firehose: {
        enabled: true,
        relay: "",
        filterByCollection: true,
        reconnectBaseMs: 1000,
        reconnectMaxMs: 60000,
    },
    auth: {
        method: "app-password",
        appPassword: "",
    },
    rateLimit: {
        maxWritesPerMinute: 30,
        maxEventsPerSecond: 100,
    },
    membership: "open",
    dualLanguage: {
        enabled: false,
        excludePredicates: [],
    },
};

/**
 * Parse settings from a raw JSON string, falling back to defaults
 * for any missing or invalid fields.
 */
export function parseSettings(raw: string | null | undefined): ATProtoSettings {
    if (!raw) return { ...DEFAULT_SETTINGS, rendering: { ...DEFAULT_SETTINGS.rendering }, firehose: { ...DEFAULT_SETTINGS.firehose }, auth: { ...DEFAULT_SETTINGS.auth }, rateLimit: { ...DEFAULT_SETTINGS.rateLimit }, dualLanguage: { ...DEFAULT_SETTINGS.dualLanguage } };
    try {
        const parsed = JSON.parse(raw);
        return {
            syncMode: validateSyncMode(parsed?.syncMode) ? parsed.syncMode : DEFAULT_SETTINGS.syncMode,
            rendering: {
                strategy: validateRenderingStrategy(parsed?.rendering?.strategy) ? parsed.rendering.strategy : DEFAULT_SETTINGS.rendering.strategy,
                chatPredicates:
                    Array.isArray(parsed?.rendering?.chatPredicates)
                        ? parsed.rendering.chatPredicates
                        : [...DEFAULT_SETTINGS.rendering.chatPredicates],
                resolveContent:
                    typeof parsed?.rendering?.resolveContent === "boolean"
                        ? parsed.rendering.resolveContent
                        : DEFAULT_SETTINGS.rendering.resolveContent,
            },
            firehose: {
                enabled:
                    typeof parsed?.firehose?.enabled === "boolean"
                        ? parsed.firehose.enabled
                        : DEFAULT_SETTINGS.firehose.enabled,
                relay:
                    typeof parsed?.firehose?.relay === "string"
                        ? parsed.firehose.relay
                        : DEFAULT_SETTINGS.firehose.relay,
                filterByCollection:
                    typeof parsed?.firehose?.filterByCollection === "boolean"
                        ? parsed.firehose.filterByCollection
                        : DEFAULT_SETTINGS.firehose.filterByCollection,
                reconnectBaseMs:
                    typeof parsed?.firehose?.reconnectBaseMs === "number" && parsed.firehose.reconnectBaseMs > 0
                        ? parsed.firehose.reconnectBaseMs
                        : DEFAULT_SETTINGS.firehose.reconnectBaseMs,
                reconnectMaxMs:
                    typeof parsed?.firehose?.reconnectMaxMs === "number" && parsed.firehose.reconnectMaxMs > 0
                        ? parsed.firehose.reconnectMaxMs
                        : DEFAULT_SETTINGS.firehose.reconnectMaxMs,
            },
            auth: {
                method:
                    parsed?.auth?.method === "app-password" || parsed?.auth?.method === "oauth"
                        ? parsed.auth.method
                        : DEFAULT_SETTINGS.auth.method,
                appPassword:
                    typeof parsed?.auth?.appPassword === "string"
                        ? parsed.auth.appPassword
                        : DEFAULT_SETTINGS.auth.appPassword,
            },
            rateLimit: {
                maxWritesPerMinute:
                    typeof parsed?.rateLimit?.maxWritesPerMinute === "number" && parsed.rateLimit.maxWritesPerMinute > 0
                        ? parsed.rateLimit.maxWritesPerMinute
                        : DEFAULT_SETTINGS.rateLimit.maxWritesPerMinute,
                maxEventsPerSecond:
                    typeof parsed?.rateLimit?.maxEventsPerSecond === "number" && parsed.rateLimit.maxEventsPerSecond > 0
                        ? parsed.rateLimit.maxEventsPerSecond
                        : DEFAULT_SETTINGS.rateLimit.maxEventsPerSecond,
            },
            membership: validateMembership(parsed?.membership) ? parsed.membership : DEFAULT_SETTINGS.membership,
            dualLanguage: {
                enabled:
                    typeof parsed?.dualLanguage?.enabled === "boolean"
                        ? parsed.dualLanguage.enabled
                        : DEFAULT_SETTINGS.dualLanguage.enabled,
                excludePredicates:
                    Array.isArray(parsed?.dualLanguage?.excludePredicates)
                        ? parsed.dualLanguage.excludePredicates
                        : [...DEFAULT_SETTINGS.dualLanguage.excludePredicates],
            },
        };
    } catch {
        return { ...DEFAULT_SETTINGS, rendering: { ...DEFAULT_SETTINGS.rendering }, firehose: { ...DEFAULT_SETTINGS.firehose }, auth: { ...DEFAULT_SETTINGS.auth }, rateLimit: { ...DEFAULT_SETTINGS.rateLimit }, dualLanguage: { ...DEFAULT_SETTINGS.dualLanguage } };
    }
}

function validateSyncMode(value: unknown): value is SyncMode {
    return value === "bidirectional" || value === "publish-only" || value === "subscribe-only";
}

function validateRenderingStrategy(value: unknown): value is "native" | "bluesky" | "dual" {
    return value === "native" || value === "bluesky" || value === "dual";
}

function validateMembership(value: unknown): value is MembershipMode {
    return value === "open" || value === "followers-only" || value === "list-only";
}
