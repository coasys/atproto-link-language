/**
 * What may be repeated from a server in an error text: nothing but an
 * allowlisted protocol error identifier and the HTTP status. A server can
 * put a secret it received or issued (a token, a code, a verifier) into any
 * field, so descriptions, messages, bodies and URLs are never quoted
 * (round 2 #1, round 3 #1).
 */

const KNOWN_ERRORS = new Set([
    "invalid_request", "invalid_client", "invalid_grant", "unauthorized_client", "unsupported_grant_type",
    "invalid_scope", "access_denied", "unsupported_response_type", "server_error", "temporarily_unavailable",
    "invalid_request_uri", "invalid_request_object", "invalid_dpop_proof", "use_dpop_nonce", "invalid_token",
    "insufficient_scope", "invalid_client_metadata", "invalid_redirect_uri", "invalid_authorization_details",
    "consent_required", "login_required", "interaction_required", "account_selection_required",
    "InvalidRequest", "InternalServerError", "AuthenticationRequired", "AuthMissing", "InvalidToken",
    "ExpiredToken", "ScopeMissingError", "RateLimitExceeded", "RecordNotFound", "RepoNotFound", "InvalidSwap",
    "AccountDeactivated", "AccountTakedown", "MethodNotImplemented", "UpstreamFailure", "UpstreamTimeout",
    "NotEnoughResources", "PayloadTooLarge", "Forbidden", "NotFound", "RepoDeactivated", "RepoTakendown",
    "RepoSuspended", "Unavailable",
]);

export function knownError(v: unknown): string {
    return typeof v === "string" && KNOWN_ERRORS.has(v) ? v : "(unrecognized error)";
}

/** A server's error reply as `<status> <known error identifier>`. */
export function serverError(r: { status: number; body: string }): string {
    try {
        const j = JSON.parse(r.body);
        if (j && typeof j === "object" && "error" in j) return `${r.status} ${knownError(j.error)}`;
    } catch {
        // not JSON: the status alone
    }
    return String(r.status);
}
