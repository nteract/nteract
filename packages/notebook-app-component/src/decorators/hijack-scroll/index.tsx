/* eslint jsx-a11y/no-static-element-interactions: 0 */
/* eslint jsx-a11y/click-events-have-key-events: 0 */

import React from "react";
import { connect } from "react-redux";
import { Dispatch } from "redux";
import scrollIntoView from "scroll-into-view-if-needed";
import { actions, selectors, ContentRef, AppState } from "@nteract/core";

interface ComponentProps {
  id: string;
  contentRef: ContentRef;
  children: React.ReactNode;
}

interface StateProps {
  focused: boolean;
}

interface DispatchProps {
  selectCell: () => void;
}

type Props = ComponentProps & DispatchProps & StateProps;

export class HijackScroll extends React.Component<Props> {
  el: HTMLDivElement | null = null;

  scrollIntoViewIfNeeded(prevFocused?: boolean): void {
    // Check if the element is being hovered over.
    const hovered =
      this.el &&
      this.el.parentElement &&
      this.el.parentElement.querySelector(":hover") === this.el;

    if (
      this.props.focused &&
      prevFocused !== this.props.focused &&
      // Don't scroll into view if already hovered over, this prevents
      // accidentally selecting text within the codemirror area
      !hovered
    ) {
      if (this.el && "scrollIntoViewIfNeeded" in this.el) {
        // This is only valid in Chrome, WebKit
        (this.el as any).scrollIntoViewIfNeeded();
      } else if (this.el) {
        // Use Pony-fill to scroll into view if needed on older browsers to mimick behavior.
        scrollIntoView(this.el, {
          scrollMode: "if-needed",
          block: "nearest",
          inline: "nearest",
        });
      }
    }
  }

  componentDidUpdate(prevProps: Props) {
    this.scrollIntoViewIfNeeded(prevProps.focused);
  }

  componentDidMount(): void {
    this.scrollIntoViewIfNeeded();
  }

  render() {
    return (
      <div
        onClick={this.props.selectCell}
        role="presentation"
        ref={(el) => {
          this.el = el;
        }}
      >
        {this.props.children}
      </div>
    );
  }
}

const makeMapStateToProps = (
  initialState: AppState,
  ownProps: ComponentProps
) => {
  const mapStateToProps = (state: AppState) => {
    const { id, contentRef } = ownProps;
    const model = selectors.model(state, { contentRef });
    let focused = false;

    if (model && model.type === "notebook") {
      focused = model.cellFocused === id;
    }

    return {
      focused,
    };
  };
  return mapStateToProps;
};

const makeMapDispatchToProps = (
  initialDispatch: Dispatch,
  ownProps: ComponentProps
) => {
  const mapDispatchToProps = (dispatch: Dispatch) => ({
    selectCell: () =>
      dispatch(
        actions.focusCell({ id: ownProps.id, contentRef: ownProps.contentRef })
      ),
  });
  return mapDispatchToProps;
};

export default connect(
  makeMapStateToProps,
  makeMapDispatchToProps
)(HijackScroll);
