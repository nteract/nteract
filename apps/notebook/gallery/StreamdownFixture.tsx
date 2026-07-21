import { Streamdown, type Components } from "streamdown";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockTitle,
  CodeBlockFilename,
} from "@/components/ui/code-block";
import type { BundledLanguage } from "shiki";

const codeBlockComponents: Components = {
  pre: ({ node }) => {
    const codeEl = (
      node as {
        children?: Array<{
          tagName?: string;
          properties?: Record<string, unknown>;
          children?: Array<{ value?: string }>;
        }>;
      }
    )?.children?.find((c) => c.tagName === "code");
    const className = String(codeEl?.properties?.className ?? "");
    const lang = (className.match(/language-(\S+)/)?.[1] ?? "text") as BundledLanguage;
    const code = codeEl?.children?.map((c) => c.value ?? "").join("") ?? "";
    return (
      <CodeBlock code={code} language={lang} className="my-4 not-prose">
        <CodeBlockHeader>
          <CodeBlockTitle>
            <CodeBlockFilename>{lang}</CodeBlockFilename>
          </CodeBlockTitle>
          <CodeBlockActions>
            <CodeBlockCopyButton />
          </CodeBlockActions>
        </CodeBlockHeader>
      </CodeBlock>
    );
  },
};

const GFM_SAMPLE = `
# Heading 1

## Heading 2

### Heading 3

#### Heading 4

##### Heading 5

###### Heading 6

---

## Paragraphs & inline

A regular paragraph with **bold**, *italic*, ~~strikethrough~~, \`inline code\`, and a [link](https://example.com).

You can also use __bold__, _italic_, and **_bold italic_** together.

Superscript: E = mc^2^
Subscript: H~2~O

> This is a blockquote.
>
> It can span multiple paragraphs and contain **formatted** text.
>
> > Nested blockquotes work too.

---

## Lists

Unordered list:

- Item one
- Item two
  - Nested item A
  - Nested item B
    - Deeply nested
- Item three

Ordered list:

1. First step
2. Second step
   1. Sub-step 2a
   2. Sub-step 2b
3. Third step

Task list (GFM checkboxes):

- [x] Design the feature
- [x] Write tests
- [ ] Ship to production
- [ ] Write docs

---

## Code

Inline \`code\` looks like this.

Python block:

\`\`\`python
def hello_world():
    print("Hello, World!")

class Greeter:
    def __init__(self, name: str) -> None:
        self.name = name

    def greet(self) -> str:
        return f"Hello, {self.name}!"
\`\`\`

TypeScript block:

\`\`\`typescript
interface User {
  id: number;
  name: string;
  email?: string;
}

async function fetchUser(id: number): Promise<User> {
  const response = await fetch(\`/api/users/\${id}\`);
  if (!response.ok) throw new Error(\`HTTP \${response.status}\`);
  return response.json() as Promise<User>;
}
\`\`\`

Bash block:

\`\`\`bash
#!/usr/bin/env bash
set -euo pipefail

# Install dependencies and run tests
npm ci
npm test -- --coverage
\`\`\`

A block with no language specified:

\`\`\`
plain text / no syntax highlighting
works here too
\`\`\`

---

## Tables (GFM)

| Name        | Type     | Default   | Description                        |
| ----------- | -------- | --------- | ---------------------------------- |
| \`timeout\`   | \`number\` | \`5000\`    | Request timeout in milliseconds    |
| \`retries\`   | \`number\` | \`3\`       | Number of retry attempts           |
| \`verbose\`   | \`boolean\`| \`false\`   | Enable verbose logging             |
| \`endpoint\`  | \`string\` | \`"/api"\`  | Base URL for all requests          |

Aligned columns:

| Left aligned | Center aligned | Right aligned |
| :----------- | :------------: | ------------: |
| alpha        |    bravo       |         delta |
| echo         |    foxtrot     |          golf |

---

## Images

![A placeholder image](https://placehold.co/600x200/e2e8f0/475569?text=placeholder+image)

---

## Horizontal rules

---

***

___

---

## Autolinks (GFM)

Visit https://example.com or email support@example.com.

---

## HTML passthrough

<details>
<summary>Click to expand</summary>

Hidden content revealed on click.

</details>

---

## Long code block (scroll test)

\`\`\`python
# A deliberately long function to test horizontal scroll
def process_data(input_data: list[dict], config: dict, verbose: bool = False, dry_run: bool = False) -> list[dict]:
    """Process input data records according to the provided configuration, optionally in dry-run mode."""
    results = []
    for idx, record in enumerate(input_data):
        if verbose:
            print(f"[{idx + 1}/{len(input_data)}] Processing record id={record.get('id', 'unknown')}")
        transformed = {k: v for k, v in record.items() if k not in config.get("exclude_fields", [])}
        if not dry_run:
            results.append(transformed)
    return results
\`\`\`

---

## Nested list with code

1. Install the package:

   \`\`\`bash
   npm install streamdown
   \`\`\`

2. Import and use:

   \`\`\`typescript
   import { Streamdown } from "streamdown";
   \`\`\`

3. Profit.

---

## Mixed inline in table

| Feature          | Status | Notes                            |
| ---------------- | :----: | -------------------------------- |
| **Bold cells**   |   ✅   | Works fine                       |
| \`code in table\` |   ✅   | Renders inline code              |
| [links](https://example.com) | ✅ | Clickable                  |
| ~~strikethrough~~ |  ✅   | GFM extension                   |
`.trim();

export function StreamdownFixture() {
  return (
    <div className="space-y-4">
      <p className="text-sm text-foreground/80">
        The exact <code className="text-xs bg-muted px-1 py-0.5 rounded">Streamdown</code> props
        used in the assistant side panel, rendered against a comprehensive GitHub-flavored Markdown
        fixture — headings, inline styles, lists, task lists, fenced code blocks with syntax
        highlighting, tables, images, and more.
      </p>

      {/* Mimic the chat bubble wrapper from AssistantPanel */}
      <div className="rounded-lg border bg-background p-4 max-w-2xl">
        <Streamdown
          mode="static"
          className="prose prose-sm dark:prose-invert max-w-none [&_ul]:pl-5 [&_ol]:pl-5"
          components={codeBlockComponents}
          linkSafety={{ enabled: false }}
          allowedTags={{ img: ["src", "alt", "title", "width", "height"] }}
        >
          {GFM_SAMPLE}
        </Streamdown>
      </div>
    </div>
  );
}
