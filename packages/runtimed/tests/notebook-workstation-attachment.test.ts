import { describe, expect, it } from "vitest";
import {
  projectNotebookWorkstationAttachmentFromClaim,
  type NotebookWorkstationAttachmentTarget,
} from "../src/notebook-workstation-attachment";

const lab2Workstation: NotebookWorkstationAttachmentTarget = {
  workstationId: "lab2",
  displayName: "lab2 workstation",
  provider: "runtime_peer",
  defaultEnvironmentLabel: "Current Python",
  environmentPolicy: "current_python",
  cpuCount: 8,
  memoryBytes: 16_000_000_000,
  workingDirectory: "/home/ubuntu/project",
};

describe("projectNotebookWorkstationAttachmentFromClaim", () => {
  it("projects accepted workstation claims as connecting RuntimeStateDoc attachments", () => {
    const attachment = projectNotebookWorkstationAttachmentFromClaim({
      workstation: lab2Workstation,
      claim: {
        status: "accepted",
        updatedAt: "2026-06-09T16:20:00.000Z",
      },
    });

    expect(attachment).toEqual({
      workstation_id: "lab2",
      display_name: "lab2 workstation",
      provider: "runtime_peer",
      default_environment_label: "Current Python",
      environment_policy: "current_python",
      status: "connecting",
      status_message: "lab2 workstation accepted the request and is starting compute.",
      cpu_count: 8,
      memory_bytes: 16_000_000_000,
      working_directory: "/home/ubuntu/project",
      updated_at: "2026-06-09T16:20:00.000Z",
    });
  });

  it("projects running workstation claims as ready RuntimeStateDoc attachments", () => {
    const attachment = projectNotebookWorkstationAttachmentFromClaim({
      workstation: lab2Workstation,
      claim: {
        status: "running",
        updatedAt: "2026-06-09T16:21:00.000Z",
      },
    });

    expect(attachment.status).toBe("ready");
    expect(attachment.status_message).toBeNull();
  });

  it("projects failed workstation claims as attention-worthy attachments", () => {
    const attachment = projectNotebookWorkstationAttachmentFromClaim({
      workstation: lab2Workstation,
      claim: {
        status: "failed",
        errorMessage: "python missing ipykernel",
        updatedAt: "2026-06-09T16:22:00.000Z",
      },
    });

    expect(attachment.status).toBe("error");
    expect(attachment.status_message).toBe("python missing ipykernel");
  });
});
