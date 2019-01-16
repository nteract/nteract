import React from "react";

interface Props {
  data: string;
  mediaType: "image/svg+xml";
}

export default class SVGDisplay extends React.PureComponent<Props> {
  static MIMETYPE = "image/svg+xml";

  static defaultProps = {
    data: "",
    mediaType: "image/svg+xml"
  };

  el?: HTMLElement | null;

  componentDidMount(): void {
    if (this.el) {
      this.el.insertAdjacentHTML("beforeend", this.props.data);
    }
  }

  componentDidUpdate(): void {
    if (!this.el) {
      return;
    }
    // clear out all DOM element children
    while (this.el.firstChild) {
      this.el.removeChild(this.el.firstChild);
    }
    this.el.insertAdjacentHTML("beforeend", this.props.data);
  }

  render() {
    return (
      <div
        ref={el => {
          this.el = el;
        }}
      />
    );
  }
}
