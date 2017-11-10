/* @flow */
import React from "react";
import { typesetMath } from "mathjax-electron";

type Props = {
  children?: React$Node
};

const MathJax: global = window ? window.MathJax : null;

function isMathJaxOkYet(): boolean {
  return (
    !window.disableMathJax &&
    typeof MathJax !== "undefined" &&
    window.MathJax &&
    window.MathJax.Hub.Queue
  );
}

export default class LatexRenderer extends React.PureComponent<Props> {
  rendered: ?HTMLElement;

  componentDidMount(): void {
    if (isMathJaxOkYet()) typesetMath(this.rendered);
  }

  componentDidUpdate(): void {
    if (isMathJaxOkYet()) typesetMath(this.rendered);
  }

  render(): ?React$Element<any> {
    return (
      <div
        ref={rendered => {
          this.rendered = rendered;
        }}
      >
        {this.props.children}
      </div>
    );
  }
}
