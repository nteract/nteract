import type { ConnectionScope } from "./scope-capabilities";

/**
 * Who a request or socket is, once a host has authenticated it. Plain data:
 * each host fills it from its own credentials, and session and access code
 * reads it the same way in notebooks and Pages.
 */
export interface AuthenticatedConnection {
  principal: string;
  operator: string;
  actorLabel: string;
  scope: ConnectionScope;
  metadata: AuthenticatedConnectionMetadata;
  webSocketProtocol?: string;
}

export interface AuthenticatedConnectionMetadata {
  provider:
    | "anonymous"
    | "app-session"
    | "dev"
    | "oidc"
    | "anaconda-api-key"
    | "workstation-credential";
  transport:
    | "anonymous"
    | "app-session-cookie"
    | "loopback-dev"
    | "dev-token-header"
    | "dev-token-subprotocol"
    | "api-key-bearer"
    | "host-session-cookie"
    | "oidc-bearer"
    | "oidc-subprotocol"
    | "workstation-credential-header";
  principalNamespace: string;
  displayName?: string;
  avatarUrl?: string;
  email?: string;
  emailVerified?: boolean;
  /** When the provider answer that verified `email` stops being current
   * (epoch ms). Set for an Anaconda API key with an email. */
  emailVerifiedUntil?: number;
  identityVerifiedAt?: number;
  verifiedEmailBinding?: string;
  verifiedEmailDomainBinding?: string;
  workstationCredentialId?: string;
  workstationPairingCodeId?: string;
}
