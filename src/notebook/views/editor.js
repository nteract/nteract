// @flow
import React from "react";
import CodeMirrorWrapper from "../components/cell/codemirror";

type Props = {
  children?: React.Element<*>
};

const EditorView = (props: Props): React.Element<*> => (
  <div className="input">
    {props.children}
  </div>
);

export default CodeMirrorWrapper(EditorView);
