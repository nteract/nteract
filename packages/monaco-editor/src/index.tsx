import { debounce } from "lodash";
import { editor } from "monaco-editor";
import * as React from "react";
import styled from "styled-components";
import language from "react-syntax-highlighter/languages/prism/makefile";

export interface MonacoEditorProps {
  theme: string;
  language?: string;
  onChange: (value: string) => void;
  value: string;
  editorFocused: boolean;
}

const MonacoContainer = styled.div`
  background-color: powderblue;
  height: 300px;
  overflow: auto;
`;

export default class MonacoEditor extends React.Component<MonacoEditorProps> {
  static defaultProps = {
    onChange: () => {},
    editorFocused: false,
    language: "plaintext"
  };

  monaco?: editor.IStandaloneCodeEditor;
  monacoContainerRef = React.createRef<HTMLDivElement>();

  componentWillMount() {
    this.componentWillReceiveProps = debounce(
      this.componentWillReceiveProps,
      0
    );
  }

  onDidChangeModelContent() {
    if (this.monaco && this.props.onChange) {
      this.props.onChange(this.monaco.getValue());
    }
  }

  componentDidMount() {
    this.monaco = editor.create(this.monacoContainerRef.current!, {
      value: this.props.value,
      language: this.props.language,
      theme: this.props.theme,
      minimap: {
        enabled: false
      },
      autoIndent: true
      
    });

    if (this.props.editorFocused) {
      this.monaco.focus();
    }

    this.monaco.onDidChangeModelContent(
      this.onDidChangeModelContent.bind(this)
    );
  }

  componentDidUpdate() {
    if (!this.monaco) {
      return;
    }

    if (this.monaco.getValue() !== this.props.value) {
      // FIXME: calling setValue resets cursor position in monaco. It shouldn't!
      this.monaco.setValue(this.props.value);
    }

    const model = this.monaco.getModel();
    if (model && this.props.language && model.getModeId() !== this.props.language) {
      editor.setModelLanguage(model, this.props.language);
    }

    if (this.props.theme) {
      editor.setTheme(this.props.theme);
    }
  }

  componentWillReceiveProps(nextProps: MonacoEditorProps) {
    if (this.monaco && this.monaco.getValue() !== nextProps.value) {
      // FIXME: calling setValue resets cursor position in monaco. It shouldn't!
      this.monaco.setValue(nextProps.value);
    }
  }

  componentWillUnmount() {
    if (this.monaco) {
      this.monaco.dispose();
    }
  }

  render() {
    return (
      <MonacoContainer className="monaco cm-s-composition" ref={this.monacoContainerRef} />
    );
  }
}
