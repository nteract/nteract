import React from "react";

/**
 * Contains a failure to draw one Page block. Without it, an error while
 * decoding or rendering a block (for example a node a later build wrote)
 * unmounts the whole viewer. The block shows a notice; the rest of the Page
 * keeps working. Reloading picks up a build that can draw it.
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
