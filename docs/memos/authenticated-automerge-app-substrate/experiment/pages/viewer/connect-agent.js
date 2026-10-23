// This page handles only public endpoint/header examples, never a credential.
const status = document.querySelector(".setup-copy-status");
if (navigator.clipboard?.writeText) {
  for (const button of document.querySelectorAll("[data-copy]")) {
    button.hidden = false;
    button.addEventListener("click", async () => {
      const value = document.getElementById(button.dataset.copy)?.textContent;
      if (!value) return;
      button.disabled = true;
      try {
        await navigator.clipboard.writeText(value);
        status.textContent =
          button.dataset.copy === "mcp-endpoint"
            ? "Server URL copied."
            : "Headers copied. Replace the placeholders in your client.";
      } catch {
        status.textContent = "Couldn't copy. Select and copy the value above.";
      } finally {
        button.disabled = false;
      }
    });
  }
}
