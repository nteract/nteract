import React from "react";

/**
 * Contains a failure to draw one Page block. Without it, an error while
 * decoding or rendering a block (for example a node a later build wrote)
 * unmounts the whole viewer. The block shows a notice; the rest of the Page
 * keeps working. Reloading picks up a build that can draw it. It only
 * renders: nothing here writes to the Page.
 */
export class BlockBoundary extends React.Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    this.props.onError?.(error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <section className="opaque" role="note" data-block-error="true">
        This block can't be shown in this version of Pages. Reload to update.
      </section>
    );
  }
}

// Calls renderBlock while rendering below the boundary, so a throw from
// renderBlock itself is caught there too.
const BlockContent = ({ block, renderBlock }) => renderBlock(block);

/** A Page's blocks in order, each in its own section and BlockBoundary, so a
 * block that throws while drawing leaves its neighbors drawn. */
export function PageBlocks({ blocks, renderBlock }) {
  return blocks.map((block) => (
    <section className="page-block" data-block-id={block.id} key={block.id}>
      <BlockBoundary
        onError={(error) =>
          console.error(`Pages block ${block.id} failed to draw:`, error?.stack ?? error)
        }
      >
        <BlockContent block={block} renderBlock={renderBlock} />
      </BlockBoundary>
    </section>
  ));
}

/**
 * The last resort for a throw outside any block, such as in the title or
 * the comments panel. It replaces the screen with a notice and a reload
 * button. It never touches the Page: the local replica keeps unsynced edits,
 * and a reload opens them again.
 */
export class ScreenBoundary extends React.Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    console.error("Pages failed to draw this screen:", error?.stack ?? error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="screen-error" role="alert">
        <h1>Pages couldn't draw this screen</h1>
        <p>Your Page wasn't changed. Edits not yet synced stay in this browser.</p>
        <button type="button" onClick={() => (this.props.reload ?? (() => location.reload()))()}>
          Reload
        </button>
      </main>
    );
  }
}
