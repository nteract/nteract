import { ArrowUpRight, Sparkles } from "lucide-react";
import type { CloudPrototypeAuthState } from "./collaborator-auth";
import { CloudNotebookSignInButton } from "./cloud-auth-controls";
import type { CloudViewerAuthConfig } from "./cloud-viewer-types";

export function CloudHostedDocumentSignedOutPanel({
  authConfig,
  authState,
  cloudDescription,
  cloudTitle,
  localDescription,
  localTitle,
}: {
  authConfig: CloudViewerAuthConfig;
  authState: CloudPrototypeAuthState;
  cloudDescription: string;
  cloudTitle: string;
  localDescription: string;
  localTitle: string;
}) {
  const localMode = Boolean(authConfig.localDev);
  const title = localMode ? localTitle : cloudTitle;
  const description = localMode ? localDescription : cloudDescription;

  return (
    <div className="cloud-notebook-signed-out" aria-labelledby="cloud-document-signed-out-title">
      <div className="cloud-notebook-signed-out-copy">
        <div className="cloud-notebook-signed-out-kicker">
          <Sparkles aria-hidden="true" />
          {localMode ? "LOCAL MODE" : "NTERACT"}
        </div>
        <h2 id="cloud-document-signed-out-title">{title}</h2>
        <p>{description}</p>
      </div>
      <div className="cloud-notebook-signed-out-actions">
        <CloudNotebookSignInButton authConfig={authConfig} authState={authState} />
        <a href="https://nteract.io/" target="_blank" rel="noreferrer">
          Visit nteract.io
          <ArrowUpRight aria-hidden="true" />
        </a>
      </div>
    </div>
  );
}
