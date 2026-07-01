import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "nteract-elements";

export function NotebookFaq() {
  return (
    <Accordion type="single" collapsible defaultValue="item-1" style={{ width: 380 }}>
      <AccordionItem value="item-1">
        <AccordionTrigger>How are outputs stored?</AccordionTrigger>
        <AccordionContent>
          Outputs live in the Automerge document alongside cell source, so every peer sees the same
          execution results without a separate sync channel.
        </AccordionContent>
      </AccordionItem>
      <AccordionItem value="item-2">
        <AccordionTrigger>What runs the kernel?</AccordionTrigger>
        <AccordionContent>
          The runtimed daemon owns kernel lifecycle and execution state, independent of any one
          notebook client.
        </AccordionContent>
      </AccordionItem>
      <AccordionItem value="item-3">
        <AccordionTrigger>Can agents execute cells directly?</AccordionTrigger>
        <AccordionContent>
          Yes, through the same MCP tool surface a human uses, referencing synced cell IDs rather
          than side-channel code strings.
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}

export function PackageInstallDetails() {
  return (
    <Accordion type="single" collapsible defaultValue="deps" style={{ width: 380 }}>
      <AccordionItem value="deps">
        <AccordionTrigger>Dependencies (uv)</AccordionTrigger>
        <AccordionContent>
          <div className="text-sm text-muted-foreground">
            numpy==1.26.4, pandas==2.2.2, pyarrow==16.1.0
          </div>
        </AccordionContent>
      </AccordionItem>
      <AccordionItem value="env">
        <AccordionTrigger>Environment</AccordionTrigger>
        <AccordionContent>
          <div className="text-sm text-muted-foreground">Python 3.12.4, venv managed by uv</div>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}
